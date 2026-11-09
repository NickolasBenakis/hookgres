# Security policy

Please report vulnerabilities privately, not in a public issue, using
[GitHub's private vulnerability reporting](https://github.com/NickolasBenakis/hookgres/security/advisories/new).
Include steps to reproduce and the affected version. You can expect a reply within 3 working
days.

Hookgres sends HTTP requests to URLs your users provide. To stop them from
reaching your internal network (SSRF), turn on the `blockPrivateAddresses`
option. It's off by default, so enabling it, or guarding your own `fetch`
transport, is your responsibility; see
[Going to production](https://hookgres.dev/docs/guides/production#block-internal-addresses-ssrf).
