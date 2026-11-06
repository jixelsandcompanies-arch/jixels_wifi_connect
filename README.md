# Jixels Wi-Fi Connect

Responsive customer portal and serverless Wi-Fi billing application for Vercel. The customer portal and admin dashboard adapt to mobile, tablet, and desktop screens. The production portal is configured at `https://jixels-wifi-connect.vercel.app`.

## Supabase and admin

1. Create a Supabase project and run migrations `001_wifi_billing.sql` through `007_mikrotik_gateway.sql` in order. The first migration seeds the initial package catalogue; manage packages in `/admin.html` after setup.
2. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as Vercel environment variables. Keep the service key server-side.
3. Create the admin user in Supabase Authentication, then insert that user's UUID in `public.admin_profiles` (role `admin`). Admin sign in checks both Supabase authentication and this allowlist.
4. Deploy/redeploy the project at `https://jixels-wifi-connect.vercel.app`.

The admin portal is installable as a PWA from `/admin.html`. After signing in, use **Install app** in the left navigation. Dashboard API responses are never cached by the service worker; the app shell is cached so the admin page can open offline, while live management data still requires internet access.

## M-Pesa billing

Configure CloudPay in Vercel with `CLOUDPAY_CONSUMER_KEY`, `CLOUDPAY_CONSUMER_SECRET`, `CLOUDPAY_WEBHOOK_SECRET`, and an explicit `CLOUDPAY_ENV`. Use `sandbox` only with CloudPay sandbox credentials for test transactions; set `production` with production credentials for live payments. The API now fails closed if the environment is unset or invalid instead of silently using the sandbox. In the CloudPay dashboard, set the payment webhook URL to `https://jixels-wifi-connect.vercel.app/api/cloudpay/webhook` and copy its signing secret into `CLOUDPAY_WEBHOOK_SECRET`. The browser does not decide price or payment state; only a valid signed CloudPay completion event for the exact amount starts a paid session. The legacy unsigned `/api/mpesa/callback` endpoint is retired; use only `/api/cloudpay/webhook`.

## Airtel 5G router captive portal

The supplied router screenshots identify the interface as `TYRAX3004H` (the device label also shows `TYR300`). The visible settings do not expose a captive-portal option, so the Airtel router cannot itself redirect guest Wi-Fi users to checkout. Website Filter and Port Forwarding do not provide captive-portal authentication. Do not expose router admin credentials in Vercel or the browser.

The Network Settings screenshot confirms the router's LAN admin address is `192.168.1.1` and DHCP leases range from `192.168.1.100` to `192.168.1.249`. The earlier `192.168.10.1` value is shown separately as the upstream Internet default gateway. Do not change the LAN or DHCP values to configure a captive portal. Vercel cannot directly reach private LAN addresses; the TYRAX option below uses a local PC agent for router API calls. The visible router firmware has no captive-portal redirect, so its local agent can allow/block a paid device but cannot force the payment page to pop up.

## MikroTik HotSpot gateway with Tenda access point

This is the supported path if you buy/use a MikroTik: Airtel LAN connects to the MikroTik WAN; the Tenda runs in AP/bridge mode with its DHCP server disabled and connects to a guest-side MikroTik LAN/bridge; guests join the Tenda's Barrio- HOTSPOT SSID. Airtel Wi-Fi must stay private for staff. Guest traffic must pass through the MikroTik HotSpot.

The MikroTik portal login page is provided in `mikrotik/hotspot/login.html`. Upload it as the HotSpot `login.html` file. It forwards RouterOS's `$(mac)` and `$(ip)` values to the Vercel portal; checkout never asks the customer to type a MAC. Add `jixels-wifi-connect.vercel.app` to the MikroTik HotSpot walled garden so the portal can load before authentication. Configure HotSpot login-by `http-pap`; the app's local agent creates a temporary RouterOS HotSpot user locked to the originating MAC and paid duration, and the customer's browser submits that one-time login after CloudPay confirms payment. Keep RouterOS management reachable only on the trusted LAN. Use RouterOS v7 REST over trusted HTTPS if available; if using HTTP, isolate it to the wired/trusted LAN and restrict it to the agent PC's IP.

In Vercel set:

* `WIFI_GATEWAY_MODE=mikrotik-agent`
* `MIKROTIK_GATEWAY_ID=main` (or another short ID, matching this site)
* `MIKROTIK_AGENT_TOKEN` to a random 32-byte token
* The CloudPay values listed above, including the signed callback at `https://jixels-wifi-connect.vercel.app/api/cloudpay/webhook`

Run migration `007_mikrotik_gateway.sql` after `001` through `006`. On the always-on Windows PC connected to the MikroTik's trusted LAN, run PowerShell from this repository:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$AgentToken = [BitConverter]::ToString($b).Replace('-', '').ToLower()
Set-Clipboard $AgentToken
# Save this token in Vercel as MIKROTIK_AGENT_TOKEN.
./tools/setup-mikrotik-agent.ps1 -AgentToken $AgentToken -RouterUrl 'http://192.168.88.1'
./tools/mikrotik-agent.ps1
```

Use your MikroTik's actual address in both places. The setup script stores the RouterOS API credential encrypted for that Windows account. Create a dedicated RouterOS API account for the agent, enable REST (`www` or `www-ssl`), and allow it to read hotspot hosts/active entries and manage active entries and IP bindings. The agent verifies the checkout IP and MAC against the live HotSpot host, then creates a session-scoped bypass binding after payment confirmation. This grants internet without waiting for the customer to stay on the packages page or submit a router login form. The every-minute expiry job asks the agent to remove that exact binding at the paid wall-clock expiry. The app polls the agent through HTTPS; Vercel never connects to the private router address. Configure CloudPay and the MikroTik mode in Vercel, then redeploy after applying migration `007`.

### Additional access point inventory

Apply `008_router_registry.sql` after migration `007` to enable **Router Management** in `/admin.html`. The migration adds an admin-only inventory and a parent reference to the configured central MikroTik gateway; it does not change hotspot, payment, package, or session data. The admin API registers Ethernet access points, wireless bridges, and repeater bridges as inventory records only. Use AP/bridge mode with DHCP/NAT disabled on the additional device so customer traffic continues through the MikroTik. Router/NAT and independent captive-portal modes are not supported by this integration. Inventory status remains **Not verified** because the application does not probe ordinary access points. A recent agent heartbeat only means the local agent contacted Jixels; it does not prove the MikroTik or an access point is reachable.

This MikroTik path requires the Tenda to be an access point behind the MikroTik. A Tenda connected directly to Airtel, or left routing with its own DHCP, bypasses the HotSpot gateway. Phone tethering through an already-authorized device cannot be reliably blocked by MAC-based HotSpot control.

## OpenNDS hotspot gateway

Keep the Airtel unit as the 5G Internet source and add a separate gateway/access point that supports OpenWrt and openNDS. Connect Airtel LAN to the new gateway's WAN; have customer devices join the new gateway's Wi-Fi, which must be the default gateway for their traffic. Keep the Airtel Wi-Fi private for administration or disable it for guests, so customers cannot bypass the hotspot. Do not flash custom firmware onto the Airtel unit unless its exact hardware revision is confirmed as supported.

The application includes an openNDS HTTPS FAS endpoint (`/api/opennds/fas`), validates the FAS level 4 gateway identity, obtains the client MAC from the gateway portal context (customers never type it), binds checkout to that client, and grants access only after the signed CloudPay webhook confirms the exact amount. The customer enters only the M-Pesa phone number. openNDS enforces each purchased duration on the gateway; the scheduled job updates Supabase session records.

For the openNDS option, run migrations `001` to `006`, configure these Vercel environment variables, and redeploy:

* `OPENNDS_GATEWAY_NAME`: exact `gatewayname` configured in openNDS.
* `OPENNDS_FAS_KEY`: long random secret, shared only between Vercel and openNDS.
* `OPENNDS_FAS_URL=https://jixels-wifi-connect.vercel.app/api/opennds/fas`.

Configure openNDS for secure level 4, port 443, and path `/api/opennds/fas`, with the same gateway name and FAS key. The guest SSID must be broadcast by this openNDS gateway. Keep its WAN connected to Airtel LAN; don't expose guest access through the Airtel Wi-Fi. Do not put the FAS key in the browser or commit it.

**Network requirement:** the gateway must allow its clients and authmon process to reach the portal host over HTTPS before authentication. openNDS documentation also requires CDN FAS deployments to use an appropriate reachable FAS IP and add the FQDN to the walled garden. Vercel uses hosted/CDN infrastructure; confirm a stable/reachable IP and walled-garden behavior on the actual router before taking live payments. If that cannot be guaranteed, host the FAS endpoint on a server with a stable public IP and TLS certificate, while keeping the customer site and billing API reachable from that FAS host. The current Airtel TYRAX3004H does not show a captive portal or openNDS option, so its admin UI cannot perform this gateway role.

Reference: [openNDS HTTPS FAS documentation](https://github.com/openNDS/openNDS/blob/master/docs/source/fas.rst) and [official configuration options](https://github.com/openNDS/openNDS/blob/master/linux_openwrt/opennds/files/etc/config/opennds). Check the OpenWrt hardware support list for the exact gateway model before buying or flashing equipment.

## Existing TYRAX router local agent

The TYRAX3004H admin interface exposes a local device block/unblock API. The Windows PowerShell bridge in `tools/tyrax-agent.ps1` can issue local commands without putting the router password in Vercel, but TYRAX does not provide captive-portal redirection. It cannot provide the full billing-to-login flow described for openNDS or MikroTik.

Run migration `005_tyrax_local_agent.sql`. In Vercel set `WIFI_GATEWAY_MODE=tyrax-agent` and `TYRAX_AGENT_TOKEN` to a fresh long random token. Generate one in Windows PowerShell with:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$AgentToken = [BitConverter]::ToString($b).Replace('-', '').ToLower()
Set-Clipboard $AgentToken
```

Paste that token into Vercel, redeploy, then in PowerShell from this repository run `./tools/setup-tyrax-agent.ps1 -AgentToken $AgentToken` and `./tools/tyrax-agent.ps1`. The setup script prompts for the TYRAX admin password and stores it encrypted for that Windows account; the password is never sent to Vercel. The PC must remain online. This bridge provides device allow/block control, **not a captive portal**; do not treat it as an automatic paywall.

## Expiry job

`vercel.json` invokes `/api/cron/expire-sessions` every minute to update session records and queue expired-device cleanup. Set a unique `CRON_SECRET`; the MikroTik agent removes each session-scoped bypass binding at paid wall-clock expiry. OpenNDS enforces paid timeouts locally. In TYRAX agent mode, the local agent checks for expired sessions every eight seconds and blocks their MACs.
