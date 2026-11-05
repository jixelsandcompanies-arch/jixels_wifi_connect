-- Payment records are created before contacting CloudPay, before its reference exists.
alter table public.payments alter column checkout_request_id drop not null;
