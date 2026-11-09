# Security policy

Please report vulnerabilities privately, not in a public issue, using
[GitHub's private vulnerability reporting](https://github.com/NickolasBenakis/hookgres/security/advisories/new).
Include steps to reproduce and the affected version. You can expect a reply within 3 working
days.

Hookgres sends HTTP requests to URLs your users provide. Guarding against
SSRF (requests to your internal network) is your responsibility; see
[Going to production](https://hookgres.dev/docs/guides/production#block-internal-addresses-ssrf).
