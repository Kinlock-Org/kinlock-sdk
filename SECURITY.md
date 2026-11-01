# Security

Please report vulnerabilities privately. Policy: [Kinlock-Org/.github SECURITY.md](https://github.com/Kinlock-Org/.github/blob/main/SECURITY.md).

## Reporting a Vulnerability

Kinlock handles financial escrow transactions on Stellar. If you discover a security vulnerability or privacy defect, **do not open a public issue.** Report it privately through GitHub's "Report a vulnerability" (Private Security Advisories) on this repository, or email the maintainers directly:
- `adenikeajala2018@gmail.com`
- `Yazarayobami76@gmail.com`

## Response & Disclosure Timelines

- **Initial Acknowledgement:** We acknowledge receipt of vulnerability reports within **48 hours**.
- **Triage & Assessment:** We assess severity and provide a remediation plan or status update within **5 business days**.
- **Coordinated Disclosure:** Fixes will be prepared, verified, and released in coordinated disclosure with the reporter. We ask reporters to adhere to responsible disclosure principles and refrain from disclosing vulnerabilities publicly until fixes have landed.

## Scope

In scope for this repository:
- `@kinlock/sdk`: Transaction building, authorization checks, preflight validations, reference memo hashing (`sha256(reference ‖ salt)`), and client-side URL fragment privacy guarantees.
- `@kinlock/indexer`: Soroban event ingestion poller, database persistence idempotency on `(tx_hash, event_index)`, and Fastify list API security.
