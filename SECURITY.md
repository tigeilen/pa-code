# Security & Privacy Policy for PA-Code

This document outlines the security, privacy, and compliance principles of the **PA-Code** extension for Visual Studio Code. We understand that IBM Planning Analytics (TM1) handles highly sensitive corporate data. Therefore, this extension is built with a strict "security by design" approach to meet enterprise compliance standards.

PA Code is **open source** under the **Apache License 2.0** and developed in the open at <https://github.com/tigeilen/pa-code>, so anyone can review the code independently.

## 1. Data Privacy & Telemetry (Zero Data Exfiltration)
**We do not track you, and we do not collect your data.**
* **No Telemetry:** The extension does not collect, store, or transmit any usage data, telemetry, or metadata to the developer or any third parties. 
* **Direct Communication Only:** The extension only communicates directly with the IBM Planning Analytics server you configure. No data is routed through external proxy servers or cloud services. 

## 2. Authentication & Credential Handling
**We do not store your credentials.**
* **Zero Credential Storage:** To ensure the highest level of security, the extension does not save passwords or authentication tokens on your local disk, in the VS Code workspace, or in configuration files. 
* **Session-Based Authentication:** Users are required to authenticate with their own credentials. Once the session is closed, the connection is terminated. 

## 3. IBM Licensing Compliance (No Multiplexing)
**The extension supports 1:1 license compliance.**
* Because every user must authenticate individually against the TM1 server, the extension acts as a standard direct client. 
* It does not act as a service account gateway or pooling mechanism. This ensures compliance with IBM’s indirect access and multiplexing licensing terms. Every user interacting with the TM1 server via this extension utilizes their own designated IBM user license.

## 4. API Usage
The extension relies exclusively on the official and documented **IBM Planning Analytics REST API**. It does not use undocumented endpoints or unauthorized methods to interact with the system. Security and access rights are enforced entirely by your TM1 server configuration.

## 5. Open Source & Code Review
PA Code is **open source**, developed in the open on GitHub under the **Apache License 2.0**. Corporate Information Security policies often require code reviews for tools connecting to financial systems — with PA Code you can do this yourself, no NDA required.
* **Full source available:** The complete source code is public at <https://github.com/tigeilen/pa-code>. Your IT/security team can read, clone, and audit the extension before deployment.
* **Reproducible build:** You can build the VSIX yourself from source to verify it matches what you install — `npm install`, then `npx webpack --mode production`, then `npx vsce package`.
* **Questions / vendor onboarding:** For due-diligence questions, contact Tim Geilen / tim.geilen@googlemail.com.

## 6. Dependency Security
We keep third-party dependencies patched and run `npm audit` as part of maintenance. As of the current release, there are **no known vulnerabilities in the runtime dependencies that are reachable in normal use**.

* **Known finding (not exploitable in this extension):** `npm audit` reports advisory GHSA-jmr9-qjv8-65gv (`extract-zip` symlink path traversal) via the transitive chain `puppeteer-core` → `@puppeteer/browsers` → `extract-zip`. This code path only runs when `@puppeteer/browsers` **downloads and extracts a bundled browser**. PA-Code never does this — it exclusively automates the **already-installed system browser (Microsoft Edge)** via `spawn`/`connect`, so the vulnerable extraction routine is never executed. Upstream's only fix (`puppeteer-core` 25) is ESM-only and would require a larger migration; we will adopt it once it can be integrated and validated without risk to the browser-based sign-in flow.
* Development-only tooling (e.g. `webpack`, test utilities) is not shipped in the packaged extension and cannot affect end users.

## 7. Reporting a Vulnerability
If you discover a potential security issue in this extension, please **do not** open a public GitHub issue or disclose it publicly. Instead, report it privately through one of these channels:
* **GitHub private vulnerability reporting** (preferred): on the repository's **Security** tab, use **“Report a vulnerability”**.
* **Email:** tim.geilen@googlemail.com.

We treat security reports as our highest priority and will respond promptly.