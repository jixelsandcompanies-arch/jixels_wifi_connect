/** Gateway hardware is intentionally isolated. Do not assume a Tenda API exists. */
export class MockGatewayAdapter {
  constructor() { this.active = new Map(); }
  async grantAccess({ sessionId, macAddress, expiresAt }) { this.active.set(sessionId, { macAddress, expiresAt }); return { gatewayReference: `mock-${sessionId}` }; }
  async revokeAccess(sessionId) { this.active.delete(sessionId); }
}
export function gatewayAdapter() { return new MockGatewayAdapter(); }
