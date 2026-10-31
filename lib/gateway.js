/**
 * Internet access must be granted by the installed router/controller. This
 * project deliberately has no simulated adapter: configure a real adapter
 * after confirming the gateway's documented API and authentication method.
 */
export function gatewayAdapter() {
  throw new Error('Wi-Fi gateway integration is not configured. Configure the installed router/controller before accepting live payments.');
}

export function isGatewayConfigured() { return false; }
