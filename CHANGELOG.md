# Changelog

## 0.2.0 - 2026-09-25

- Added revocable personal access tokens bound to a user, one team, a maximum scope, and optionally one space.
- Added the official MCP TypeScript SDK stateless HTTP endpoint and stdio forwarding bridge.
- Reused REST handlers and live ACL checks for MCP calls; unknown routes deny Bearer authentication by default.
- Added role-aware credential management, use auditing, restore-time token revocation, and pagination for agent lists.
- Added protocol, authorization, role-downgrade, ACL-change, restore-compatibility, and stdio bridge tests.
