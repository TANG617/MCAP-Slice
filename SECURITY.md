# Security Policy

## Supported releases

Security fixes target the latest release available from
[GitHub Releases](https://github.com/TANG617/MCAP-Slice/releases). Older
packages may not receive backports.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's
[private vulnerability reporting](https://github.com/TANG617/MCAP-Slice/security/advisories/new)
to send the maintainers:

- the affected platform and package;
- a concise description of the impact;
- reproduction steps or a proof of concept;
- whether untrusted MCAP content is required; and
- any suggested mitigation.

Do not attach private or proprietary recordings. Reduce the issue to a
synthetic MCAP whenever possible.

The maintainers will acknowledge the report through the private advisory,
investigate it, and coordinate disclosure after a fix or mitigation is
available. No fixed response-time SLA is promised.

## Security-sensitive areas

Reports are especially useful for:

- malformed MCAP records that cause memory safety problems;
- unsafe handling of untrusted image payloads;
- path traversal or unintended file overwrite;
- sensitive path or recording information written to output Metadata; and
- packaged dependencies with a relevant known vulnerability.

Normal crashes, unsupported codecs, feature requests, and non-sensitive data
compatibility problems belong in
[GitHub Issues](https://github.com/TANG617/MCAP-Slice/issues).
