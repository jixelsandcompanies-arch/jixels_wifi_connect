# Jixels Wi-Fi Connect

Static customer portal and serverless M-Pesa billing application for Vercel. The production portal is configured at `https://jixels-wifi-connect.vercel.app`.

## Supabase and admin

1. Create a Supabase project and run migrations `001_wifi_billing.sql` through `006_opennds_auth_ack.sql` in order. The first migration seeds the initial package catalogue; manage packages in `/admin.html` after setup.
2. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as Vercel environment variables. Keep the service key server-side.
3. Create the admin user in Supabase Authentication, then insert that user's UUID in `public.admin_profiles` (role `admin`). Admin sign in checks both Supabase authentication and this allowlist.
4. Deploy/redeploy the project at `https://jixels-wifi-connect.vercel.app`.

## M-Pesa billing

Configure CloudPay in Vercel with `CLOUDPAY_CONSUMER_KEY`, `CLOUDPAY_CONSUMER_SECRET`, `CLOUDPAY_WEBHOOK_SECRET`, and `CLOUDPAY_ENV=sandbox`. In the CloudPay dashboard, set the payment webhook URL to `https://jixels-wifi-connect.vercel.app/api/cloudpay/webhook` and copy its signing secret into `CLOUDPAY_WEBHOOK_SECRET`. The browser does not decide price or payment state; only a valid signed CloudPay completion event for the exact amount starts a paid session. Switch `CLOUDPAY_ENV=production` only after sandbox checkout and webhook verification.

## Airtel 5G router captive portal

The supplied router screenshots identify the interface as `TYRAX3004H` (the device label also shows `TYR300`). The Wi-Fi page uses personal WPA/WPA2 security. The visible **More Settings** list has firewall, QoS, port forwarding, website filter, static routes, dynamic DNS, and hardware NAT. The expanded **Management** menu has Time, System Log, System Admin, and Upgrade. None of the shown settings exposes a captive-portal option. The remaining place to check is **Wi-Fi â†’ Advanced Settings** for a **Hotspot**, **Guest Portal**, **External Portal**, or **Portal Server** option. Only if that feature exists, set its landing/login URL to `https://jixels-wifi-connect.vercel.app` and configure its MAC query parameter as `client_mac`; the portal reads that parameter and forwards the device MAC with checkout. Do not substitute Website Filter or Port Forwarding; they do not provide captive-portal authentication. Do not expose router admin credentials in Vercel or the browser.

The Network Settings screenshot confirms the router's LAN admin address is `192.168.1.1` and DHCP leases range from `192.168.1.100` to `192.168.1.249`. The earlier `192.168.10.1` value is shown separately as the upstream Internet default gateway. Do not change the LAN or DHCP values to configure a captive portal. Vercel cannot directly reach private LAN addresses; the TYRAX option below uses a local PC agent for router API calls. The visible router firmware has no captive-portal redirect, so its local agent can allow/block a paid device but cannot force the payment page to pop up.

## OpenNDS hotspot gateway

Keep the Airtel unit as the 5G Internet source and add a separate gateway/access point that supports OpenWrt and openNDS. Connect Airtel LAN to the new gateway's WAN; have customer devices join the new gateway's Wi-Fi, which must be the default gateway for their traffic. Keep the Airtel Wi-Fi private for administration or disable it for guests, so customers cannot bypass the hotspot. Do not flash custom firmware onto the Airtel unit unless its exact hardware revision is confirmed as supported.

The application now includes an openNDS HTTPS FAS endpoint (`/api/opennds/fas`), validates the FAS level 4 gateway identity, obtains the client MAC from the signed gateway portal context (customers never type it), binds checkout to that client, queues authorization only after the Daraja callback confirms the exact amount, and waits for authmon's signed acknowledgement before showing the client's session as active. The customer enters only the M-Pesa phone number. openNDS enforces each purchased duration on the gateway; the scheduled job updates Supabase session records.

For production, run migrations `001` to `006`, configure these Vercel environment variables, and redeploy:

* `OPENNDS_GATEWAY_NAME`: exact `gatewayname` configured in openNDS.
* `OPENNDS_FAS_KEY`: long random secret, shared only between Vercel and openNDS.
* `OPENNDS_FAS_URL=https://jixels-wifi-connect.vercel.app/api/opennds/fas`.

Configure openNDS for secure level 4, port 443, and path `/api/opennds/fas`, with the same gateway name and FAS key. The guest SSID must be broadcast by this openNDS gateway. Keep its WAN connected to Airtel LAN; don't expose guest access through the Airtel Wi-Fi. Do not put the FAS key in the browser or commit it.

**Network requirement:** the gateway must allow its clients and authmon process to reach the portal host over HTTPS before authentication. openNDS documentation also requires CDN FAS deployments to use an appropriate reachable FAS IP and add the FQDN to the walled garden. Vercel uses hosted/CDN infrastructure; confirm a stable/reachable IP and walled-garden behavior on the actual router before taking live payments. If that cannot be guaranteed, host the FAS endpoint on a server with a stable public IP and TLS certificate, while keeping the customer site and billing API reachable from that FAS host. The current Airtel TYRAX3004H does not show a captive portal or openNDS option, so its admin UI cannot perform this gateway role.

Reference: [openNDS HTTPS FAS documentation](https://github.com/openNDS/openNDS/blob/master/docs/source/fas.rst) and [official configuration options](https://github.com/openNDS/openNDS/blob/master/linux_openwrt/opennds/files/etc/config/opennds). Check the OpenWrt hardware support list for the exact gateway model before buying or flashing equipment.

## Existing TYRAX router local agent

The TYRAX3004H admin interface exposes a local device block/unblock API. To use it without putting the router password in Vercel, run the Windows PowerShell bridge in `tools/tyrax-agent.ps1` on a PC that stays powered on and connected to the same LAN as the router. The agent mode cannot automatically associate a checkout phone number with a connected device; phone-only checkout is supported through openNDS, which supplies the device MAC in its portal context.

Run migration `005_tyrax_local_agent.sql`. In Vercel set `WIFI_GATEWAY_MODE=tyrax-agent` and `TYRAX_AGENT_TOKEN` to a fresh long random token. Generate one in Windows PowerShell with:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$AgentToken = [BitConverter]::ToString($b).Replace('-', '').ToLower()
Set-Clipboard $AgentToken
```

Paste that token into Vercel, redeploy, then in PowerShell from this repository run `./tools/setup-tyrax-agent.ps1 -AgentToken $AgentToken` and `./tools/tyrax-agent.ps1`. The setup script prompts for the TYRAX admin password and stores it encrypted for that Windows account; the password is never sent to Vercel. The PC must remain online. This bridge provides device allow/block control, **not a captive portal**. It cannot provide automatic phone-only device identification or prevent unpaid access unless a default-deny policy and access to the payment site for blocked devices are configured and confirmed on the router.

## Expiry job

`vercel.json` invokes `/api/cron/expire-sessions` every five minutes. Set a unique `CRON_SECRET`; openNDS enforces paid session timeouts locally. In TYRAX agent mode, the local agent also checks for expired sessions every eight seconds and blocks their MACs.
