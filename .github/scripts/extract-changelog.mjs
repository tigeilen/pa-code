// Extracts the CHANGELOG.md section for a given version and prints it to stdout.
// Usage: node extract-changelog.mjs 3.8.1
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
    process.stderr.write('Usage: extract-changelog.mjs <version>\n');
    process.exit(1);
}

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split(/\r?\n/);

// Match headings like: ## [3.8.1] - 2026-09-24
const headingRe = /^##\s+\[([^\]]+)\]/;
let capturing = false;
const out = [];

for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
        if (capturing) break; // reached the next version section
        if (m[1] === version) {
            capturing = true;
            continue; // skip the heading line itself
        }
    }
    if (capturing) out.push(line);
}

process.stdout.write(out.join('\n').trim() + '\n');
