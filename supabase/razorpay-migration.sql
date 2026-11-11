-- Apply once to an existing Wayfare database after updating the application files.
-- Existing rides and payment rows are retained. Stripe payment identifiers remain as legacy data.

alter table public.rides drop constraint if exists rides_payment_method_check;
update public.rides
set payment_method = 'Razorpay Checkout'
where payment_method = 'Card (Razorpay)';
update public.rides
set payment_method = 'Stripe Checkout'
where payment_method = 'Card (Stripe)';
alter table public.rides
  add constraint rides_payment_method_check check (payment_method in ('Cash', 'Razorpay Checkout', 'Stripe Checkout'));

alter table public.payments add column if not exists razorpay_order_id text;
alter table public.payments add column if not exists razorpay_payment_id text;

create unique index if not exists payments_razorpay_order_id_key
  on public.payments (razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists payments_razorpay_payment_id_key
  on public.payments (razorpay_payment_id) where razorpay_payment_id is not null;
