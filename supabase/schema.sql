-- Apply in Supabase SQL Editor after connecting Clerk as a third-party JWT provider.
-- Client keys are publishable only; these policies rely on Clerk's JWT `sub` claim.
create extension if not exists pgcrypto;

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  rider_id text not null,
  driver_id text,
  driver_name text,
  pickup text not null,
  destination text not null,
  pickup_lat double precision,
  pickup_lng double precision,
  destination_lat double precision,
  destination_lng double precision,
  stops jsonb not null default '[]'::jsonb,
  ride_type text not null check (ride_type in ('Wayfare Go','Wayfare Comfort','Wayfare XL')),
  fare_estimate integer not null check (fare_estimate >= 0),
  cancellation_fee integer not null default 0 check (cancellation_fee >= 0),
  scheduled_for timestamptz,
  payment_method text not null default 'Cash' check (payment_method in ('Cash','Razorpay Checkout','Stripe Checkout')),
  status text not null default 'requested' check (status in ('requested','accepted','driver_arriving','in_progress','completed','cancelled')),
  promo_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rides_rider_created on public.rides (rider_id, created_at desc);
create index if not exists rides_driver_created on public.rides (driver_id, created_at desc);
alter table public.rides add column if not exists stops jsonb not null default '[]'::jsonb;
alter table public.rides add column if not exists payment_method text not null default 'Cash';
alter table public.rides drop constraint if exists rides_payment_method_check;
update public.rides set payment_method = 'Stripe Checkout' where payment_method = 'Card (Stripe)';
update public.rides set payment_method = 'Razorpay Checkout' where payment_method = 'Card (Razorpay)';
alter table public.rides add constraint rides_payment_method_check check (payment_method in ('Cash','Razorpay Checkout','Stripe Checkout'));
alter table public.rides add column if not exists cancellation_fee integer not null default 0 check (cancellation_fee >= 0);

create table if not exists public.ride_reviews (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.rides(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  review text check (char_length(review) <= 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  rider_id text not null,
  ride_id uuid references public.rides(id) on delete set null,
  subject text not null,
  message text not null check (char_length(message) <= 5000),
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  created_at timestamptz not null default now()
);

create table if not exists public.ride_declines (
  ride_id uuid not null references public.rides(id) on delete cascade,
  driver_id text not null,
  created_at timestamptz not null default now(),
  primary key (ride_id, driver_id)
);

create table if not exists public.ride_locations (
  ride_id uuid primary key references public.rides(id) on delete cascade,
  driver_id text not null,
  lat double precision not null,
  lng double precision not null,
  heading double precision,
  speed double precision,
  updated_at timestamptz not null default now()
);

create table if not exists public.sos_events (
  id uuid primary key default gen_random_uuid(),
  rider_id text not null,
  ride_id uuid references public.rides(id) on delete set null,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.rides(id) on delete cascade,
  rider_id text not null,
  stripe_checkout_session_id text unique, -- retained for any historical Stripe payment rows
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  amount integer not null check (amount >= 0),
  currency text not null default 'inr',
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  created_at timestamptz not null default now()
);
alter table public.payments add column if not exists razorpay_order_id text;
alter table public.payments add column if not exists razorpay_payment_id text;
create unique index if not exists payments_razorpay_order_id_key on public.payments (razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists payments_razorpay_payment_id_key on public.payments (razorpay_payment_id) where razorpay_payment_id is not null;

create table if not exists public.promo_codes (
  code text primary key,
  discount_amount integer not null default 0 check (discount_amount >= 0),
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  usage_limit integer not null default 10000,
  usage_count integer not null default 0
);
insert into public.promo_codes(code, discount_amount, usage_limit)
values ('WAYFARE150', 150, 10000) on conflict (code) do nothing;

create table if not exists public.promo_redemptions (
  code text not null references public.promo_codes(code),
  rider_id text not null,
  ride_id uuid not null unique references public.rides(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key(code, rider_id)
);

alter table public.rides enable row level security;
alter table public.ride_reviews enable row level security;
alter table public.support_tickets enable row level security;
alter table public.ride_declines enable row level security;
alter table public.ride_locations enable row level security;
alter table public.sos_events enable row level security;
alter table public.payments enable row level security;
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;

-- Explicit Data API grants: table exposure is disabled in the project defaults.
-- RLS policies below continue to scope each operation to the authenticated rider/driver.
grant usage on schema public to authenticated;
grant select on public.rides, public.ride_reviews, public.ride_declines,
  public.ride_locations, public.sos_events, public.payments,
  public.promo_codes, public.promo_redemptions to authenticated;
grant update on public.rides to authenticated;
grant insert, update on public.ride_locations to authenticated;
grant insert on public.ride_reviews, public.ride_declines,
  public.sos_events, public.support_tickets to authenticated;

drop policy if exists "Riders read own rides" on public.rides;
create policy "Riders read own rides" on public.rides for select using (rider_id = (select auth.jwt()->>'sub'));
drop policy if exists "Riders request own rides" on public.rides;
create policy "Riders request own rides" on public.rides for insert with check (rider_id = (select auth.jwt()->>'sub') and status = 'requested');
drop policy if exists "Riders cancel own requested rides" on public.rides;
create policy "Riders cancel own requested rides" on public.rides for update using (rider_id = (select auth.jwt()->>'sub') and status = 'requested') with check (rider_id = (select auth.jwt()->>'sub') and status = 'cancelled');
drop policy if exists "Drivers see open or assigned rides" on public.rides;
create policy "Drivers see open or assigned rides" on public.rides for select using ((auth.jwt()->>'user_role' = 'driver' and status = 'requested') or driver_id = (select auth.jwt()->>'sub'));
drop policy if exists "Drivers accept or update assigned rides" on public.rides;
create policy "Drivers accept or update assigned rides" on public.rides for update using (auth.jwt()->>'user_role' = 'driver' and (status = 'requested' or driver_id = (select auth.jwt()->>'sub'))) with check (auth.jwt()->>'user_role' = 'driver' and driver_id = (select auth.jwt()->>'sub') and status in ('accepted','driver_arriving','in_progress','completed'));

create or replace function public.accept_ride(p_ride_id uuid, p_driver_name text)
returns setof public.rides
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(auth.jwt()->>'user_role','') <> 'driver' then raise exception 'Driver account required'; end if;
  return query update public.rides r
    set driver_id = auth.jwt()->>'sub', driver_name = left(p_driver_name, 100), status = 'accepted', updated_at = now()
    where r.id = p_ride_id and r.status = 'requested'
    returning r.*;
end;
$$;
revoke all on function public.accept_ride(uuid, text) from public;
grant execute on function public.accept_ride(uuid, text) to authenticated;

create or replace function public.update_assigned_ride_status(p_ride_id uuid, p_status text)
returns setof public.rides
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(auth.jwt()->>'user_role','') <> 'driver' then raise exception 'Driver account required'; end if;
  return query update public.rides r
    set status = p_status, updated_at = now()
    where r.id = p_ride_id and r.driver_id = auth.jwt()->>'sub' and (
      (r.status = 'accepted' and p_status = 'driver_arriving') or
      (r.status = 'driver_arriving' and p_status = 'in_progress') or
      (r.status = 'in_progress' and p_status = 'completed')
    ) returning r.*;
end;
$$;
revoke all on function public.update_assigned_ride_status(uuid, text) from public;
grant execute on function public.update_assigned_ride_status(uuid, text) to authenticated;

create or replace function public.cancel_ride(p_ride_id uuid)
returns setof public.rides
language plpgsql
security definer
set search_path = public
as $$
declare rider text := auth.jwt()->>'sub';
begin
  if rider is null then raise exception 'Sign-in required'; end if;
  return query update public.rides r
    set status = 'cancelled', cancellation_fee = 0, updated_at = now()
    where r.id = p_ride_id and r.rider_id = rider and r.status in ('requested','accepted','driver_arriving')
    returning r.*;
end;
$$;
revoke all on function public.cancel_ride(uuid) from public;
grant execute on function public.cancel_ride(uuid) to authenticated;

drop policy if exists "Riders read reviews for own rides" on public.ride_reviews;
create policy "Riders read reviews for own rides" on public.ride_reviews for select using (exists (select 1 from public.rides r where r.id = ride_id and r.rider_id = (select auth.jwt()->>'sub')));
drop policy if exists "Drivers read reviews for assigned rides" on public.ride_reviews;
create policy "Drivers read reviews for assigned rides" on public.ride_reviews for select using (exists (select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.jwt()->>'sub')));
drop policy if exists "Riders review own completed rides" on public.ride_reviews;
create policy "Riders review own completed rides" on public.ride_reviews for insert with check (exists (select 1 from public.rides r where r.id = ride_id and r.rider_id = (select auth.jwt()->>'sub') and r.status = 'completed'));

drop policy if exists "Riders manage own support tickets" on public.support_tickets;
create policy "Riders manage own support tickets" on public.support_tickets for all using (rider_id = (select auth.jwt()->>'sub')) with check (rider_id = (select auth.jwt()->>'sub'));
drop policy if exists "Drivers record own declines" on public.ride_declines;
create policy "Drivers record own declines" on public.ride_declines for insert with check (driver_id = (select auth.jwt()->>'sub') and auth.jwt()->>'user_role' = 'driver');
drop policy if exists "Drivers read own declines" on public.ride_declines;
create policy "Drivers read own declines" on public.ride_declines for select using (driver_id = (select auth.jwt()->>'sub'));
drop policy if exists "Riders and assigned drivers read ride locations" on public.ride_locations;
create policy "Riders and assigned drivers read ride locations" on public.ride_locations for select using (exists (select 1 from public.rides r where r.id = ride_id and (r.rider_id = (select auth.jwt()->>'sub') or r.driver_id = (select auth.jwt()->>'sub'))));
drop policy if exists "Assigned drivers publish ride locations" on public.ride_locations;
create policy "Assigned drivers publish ride locations" on public.ride_locations for all using (driver_id = (select auth.jwt()->>'sub') and auth.jwt()->>'user_role' = 'driver' and exists (select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.jwt()->>'sub'))) with check (driver_id = (select auth.jwt()->>'sub') and auth.jwt()->>'user_role' = 'driver' and exists (select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.jwt()->>'sub')));
drop policy if exists "Riders create SOS events for own rides" on public.sos_events;
create policy "Riders create SOS events for own rides" on public.sos_events for insert with check (rider_id = (select auth.jwt()->>'sub') and (ride_id is null or exists (select 1 from public.rides r where r.id = ride_id and r.rider_id = (select auth.jwt()->>'sub'))));
drop policy if exists "Riders and assigned drivers read SOS events" on public.sos_events;
create policy "Riders and assigned drivers read SOS events" on public.sos_events for select using (rider_id = (select auth.jwt()->>'sub') or exists (select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.jwt()->>'sub')));
drop policy if exists "Riders read own payments" on public.payments;
create policy "Riders read own payments" on public.payments for select using (rider_id = (select auth.jwt()->>'sub'));
drop policy if exists "Read active promo codes" on public.promo_codes;
create policy "Read active promo codes" on public.promo_codes for select using (active and starts_at <= now() and (expires_at is null or expires_at > now()) and usage_count < usage_limit);
drop policy if exists "Riders read own promo redemptions" on public.promo_redemptions;
create policy "Riders read own promo redemptions" on public.promo_redemptions for select using (rider_id = (select auth.jwt()->>'sub'));

create or replace function public.request_ride(
  p_pickup text, p_destination text, p_pickup_lat double precision, p_pickup_lng double precision,
  p_destination_lat double precision, p_destination_lng double precision, p_stops jsonb,
  p_ride_type text, p_distance_km double precision, p_scheduled_for timestamptz,
  p_payment_method text, p_promo_code text
)
returns setof public.rides
language plpgsql
security definer
set search_path = public
as $$
declare
  rider text := auth.jwt()->>'sub';
  base integer;
  rate integer;
  total integer;
  demand numeric := 1;
  pickup_local timestamp;
  discount integer := 0;
  promo text := nullif(upper(trim(p_promo_code)), '');
  new_id uuid := gen_random_uuid();
begin
  if rider is null then raise exception 'Sign-in required'; end if;
  if jsonb_typeof(coalesce(p_stops, '[]'::jsonb)) <> 'array' then raise exception 'Stops must be a list'; end if;
  if jsonb_array_length(coalesce(p_stops, '[]'::jsonb)) > 3 then raise exception 'Maximum of three stops'; end if;
  if p_ride_type = 'Wayfare Go' then base := 45; rate := 18;
  elsif p_ride_type = 'Wayfare Comfort' then base := 75; rate := 25;
  elsif p_ride_type = 'Wayfare XL' then base := 120; rate := 34;
  else raise exception 'Unknown ride type'; end if;
  if p_distance_km is null or p_distance_km < 1 or p_distance_km > 300 then raise exception 'Route distance is invalid'; end if;
  pickup_local := coalesce(p_scheduled_for, now()) at time zone 'Asia/Kolkata';
  if extract(isodow from pickup_local) >= 6 then demand := demand * 1.1; end if;
  if (extract(hour from pickup_local) >= 8 and extract(hour from pickup_local) < 11) or (extract(hour from pickup_local) >= 17 and extract(hour from pickup_local) < 21) then demand := demand * 1.2; end if;
  total := round(((base + rate * p_distance_km) * demand) / 10.0)::integer * 10;
  if p_payment_method not in ('Cash','Razorpay Checkout') then raise exception 'Unknown payment method'; end if;
  if promo is not null then
    update public.promo_codes
      set usage_count = usage_count + 1
      where code = promo and active and starts_at <= now() and (expires_at is null or expires_at > now()) and usage_count < usage_limit
      returning discount_amount into discount;
    if not found then raise exception 'Promo code is invalid, expired, or fully redeemed'; end if;
    if exists (select 1 from public.promo_redemptions where code = promo and rider_id = rider) then raise exception 'This promo code was already used on your account'; end if;
  end if;
  insert into public.rides(id, rider_id, pickup, destination, pickup_lat, pickup_lng, destination_lat, destination_lng, stops, ride_type, fare_estimate, scheduled_for, payment_method, status, promo_code)
  values (new_id, rider, left(p_pickup, 300), left(p_destination, 300), p_pickup_lat, p_pickup_lng, p_destination_lat, p_destination_lng, coalesce(p_stops, '[]'::jsonb), p_ride_type, greatest(0, total - discount), p_scheduled_for, p_payment_method, 'requested', promo);
  if promo is not null then insert into public.promo_redemptions(code, rider_id, ride_id) values (promo, rider, new_id); end if;
  return query select * from public.rides where id = new_id;
end;
$$;
revoke all on function public.request_ride(text,text,double precision,double precision,double precision,double precision,jsonb,text,double precision,timestamptz,text,text) from public;
grant execute on function public.request_ride(text,text,double precision,double precision,double precision,double precision,jsonb,text,double precision,timestamptz,text,text) to authenticated;

-- Enable `rides` in Supabase Database > Publications for live driver status updates.
