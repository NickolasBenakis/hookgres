# Security policy

Please report vulnerabilities privately by email to
**nickolasbenele@gmail.com**, not in a public issue. Include steps to
reproduce and the affected version. You can expect a reply within 3 working
days.

Hookgres sends HTTP requests to URLs your users provide. Guarding against
SSRF (requests to your internal network) is your responsibility; see
"Security note" in the README.
