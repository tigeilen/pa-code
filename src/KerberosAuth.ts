/**
 * SPNEGO / Kerberos ("Negotiate") authentication for TM1 Integrated Login
 * (IntegratedSecurityMode 2/3 servers configured for Kerberos).
 *
 * This is what native clients like Architect do: on Windows the MongoDB
 * `kerberos` module uses SSPI with the current logged-in domain session, so it
 * obtains a Kerberos service ticket transparently — true SSO, no password. On
 * macOS/Linux it uses GSSAPI (a ticket from the system credential cache).
 *
 * The native module is OPTIONAL and loaded lazily: if it isn't present or can't
 * load on the current platform, {@link isKerberosAvailable} returns false and
 * the caller falls back to the NTLM handshake — the extension keeps working.
 */

// `kerberos` is declared as a webpack external so the native binding is required
// at runtime from the shipped node_modules instead of being bundled.
let kerberosLib: any;
let kerberosLoaded = false;

function loadKerberos(): any {
    if (!kerberosLoaded) {
        kerberosLoaded = true;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            kerberosLib = require('kerberos');
        } catch {
            kerberosLib = null;
        }
    }
    return kerberosLib;
}

/** True when the native Kerberos component could be loaded on this machine. */
export function isKerberosAvailable(): boolean {
    return !!loadKerberos();
}

export interface KerberosHandshakeResult {
    status: number;
    headers: Record<string, any>;
}

/**
 * Runs an SPNEGO/Kerberos "Negotiate" handshake against `target` using the
 * supplied (keep-alive) axios client. Returns the final HTTP response (the
 * caller extracts the TM1SessionId cookie from its headers).
 *
 * @param client       axios instance with `validateStatus: () => true`
 * @param target       full URL, e.g. https://host/api/v1/ActiveUser
 * @param hostname     host used to build the service principal (HTTP/<host>)
 * @param spnOverride  optional explicit service name (e.g. "HTTP@fqdn")
 * @param log          optional diagnostic logger
 * @throws if the native module is unavailable or a transport error occurs.
 */
export async function kerberosNegotiate(
    client: any,
    target: string,
    hostname: string,
    spnOverride?: string,
    log?: (msg: string) => void
): Promise<KerberosHandshakeResult> {
    const kerberos = loadKerberos();
    if (!kerberos) throw new Error('native kerberos module not available');

    // GSSAPI service-name form "HTTP@host" maps to the SPN "HTTP/host".
    const service = spnOverride && spnOverride.trim().length > 0
        ? spnOverride.trim()
        : `HTTP@${hostname}`;

    // IMPORTANT: use the Kerberos mechanism, NOT SPNEGO/Negotiate.
    // On Windows the module maps GSS_MECH_OID_SPNEGO → the "Negotiate" SSPI
    // package, which silently falls back to NTLM when it cannot obtain a
    // Kerberos ticket — and a Kerberos-only TM1 server then rejects the NTLM
    // token ("the client is using NTLM"). GSS_MECH_OID_KRB5 selects the
    // "Kerberos" package directly, producing a genuine Kerberos token (and, if
    // no ticket can be obtained, it fails cleanly so we fall back to our own
    // NTLM handshake instead of sending a mismatched token).
    log?.(`  [Kerberos] initializeClient service='${service}' mech=KRB5`);
    const kclient = await kerberos.initializeClient(service, { mechOID: kerberos.GSS_MECH_OID_KRB5 });

    let challenge = '';
    let response: any;
    // SPNEGO can need several legs (mutual-auth continuation); Kerberos usually
    // completes in one. Bound the loop defensively.
    for (let leg = 0; leg < 5; leg++) {
        const token: string = await kclient.step(challenge);
        log?.(`  [Kerberos] leg ${leg + 1}: sending token (${token ? token.length : 0} b64 chars)`);
        response = await client.get(target, {
            headers: { 'Authorization': `Negotiate ${token}`, 'Accept': 'application/json' }
        });
        log?.(`  [Kerberos] leg ${leg + 1}: HTTP ${response.status}`);
        if (response.status !== 401) {
            return { status: response.status, headers: response.headers };
        }
        // Continuation: read the server's next Negotiate token, if any.
        const wa = String(response.headers['www-authenticate'] || '');
        const m = /Negotiate\s+([^\s,]+)/i.exec(wa);
        if (!m) {
            // No continuation token — the server rejected us; let the caller
            // decide (it will fall back to NTLM).
            log?.(`  [Kerberos] 401 with no continuation token (www-authenticate='${wa.slice(0, 40)}')`);
            return { status: response.status, headers: response.headers };
        }
        challenge = m[1];
    }
    return { status: response.status, headers: response.headers };
}
