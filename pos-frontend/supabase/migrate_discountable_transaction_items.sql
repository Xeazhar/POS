-- Track whether each sale line is eligible for PWD/Senior discount
-- and how much discount was actually applied to that line.

alter table transaction_items
  add column if not exists discount_eligible boolean not null default false;

alter table transaction_items
  add column if not exists discount_amount numeric(10,2) not null default 0;

