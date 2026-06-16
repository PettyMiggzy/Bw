-- $CHRONIC shop orders. Written server-side by /api/order.js (service key) after
-- a customer pays in SOL. RLS on, no anon access — orders are private. View/manage
-- them in the Supabase table editor (or wire an admin endpoint later).

create table if not exists public.grow_orders (
  id          text primary key,          -- first 16 chars of the payment tx signature
  tx          text not null,             -- full Solana payment signature (source of truth)
  items       jsonb not null,            -- [{id,name,size,price,qty}]
  ship        jsonb not null,            -- {name,email,addr,city,state,zip,country}
  buyer_wallet text,                     -- payer's wallet (where cashback is sent)
  ref         text,                      -- referral code/wallet that sent the customer (nullable)
  total_sol   numeric default 0,
  total_usd   numeric default 0,         -- net charged (after holder discount)
  gross_usd   numeric default 0,         -- pre-discount cart total
  discount_pct      numeric default 0,   -- $CHRONIC holder discount applied
  cashback_chronic  numeric default 0,   -- $CHRONIC owed to the buyer (paid out by worker)
  cashback_paid     boolean default false,
  cashback_tx       text,                -- payout signature once sent
  holder_bal        numeric default 0,   -- buyer's $CHRONIC balance at checkout
  status      text default 'new',        -- new | ordered | shipped | done | refunded
  created_at  timestamptz default now()
);

create index if not exists grow_orders_created_idx on public.grow_orders (created_at desc);
create index if not exists grow_orders_status_idx  on public.grow_orders (status);

-- if the table already existed, add the newer columns safely:
alter table public.grow_orders add column if not exists ref text;
alter table public.grow_orders add column if not exists gross_usd numeric default 0;
alter table public.grow_orders add column if not exists discount_pct numeric default 0;
alter table public.grow_orders add column if not exists cashback_chronic numeric default 0;  -- $CHRONIC owed to buyer
alter table public.grow_orders add column if not exists cashback_paid boolean default false;
alter table public.grow_orders add column if not exists cashback_tx text;
alter table public.grow_orders add column if not exists holder_bal numeric default 0;
alter table public.grow_orders add column if not exists buyer_wallet text;

alter table public.grow_orders enable row level security;
-- No policies => anon/auth clients get nothing. The service key (used by
-- /api/order.js) bypasses RLS, so only the server can read/write orders.
