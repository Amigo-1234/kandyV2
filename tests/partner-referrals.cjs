// Run: NODE_PATH=/path/to/node_modules node tests/partner-referrals.cjs
// Isolated PostgreSQL engine; existing referral functions are loaded unchanged.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const assert = require('node:assert/strict');
let checkCount = 0;
for (const method of ['equal','deepEqual','ok','rejects']) {
 const original = assert[method].bind(assert);
 assert[method] = (...args) => { checkCount++; return original(...args); };
}
(async () => {
 const db = new PGlite();
 const base = fs.readFileSync('supabase/migrations/20260814000074_kandy_rewards.sql','utf8');
 const fn = name => base.slice(base.indexOf('create or replace function public.'+name+'('),base.indexOf('\n$$;',base.indexOf('create or replace function public.'+name+'('))+4);
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
 create function public.is_manager() returns boolean language sql as $$ select coalesce(current_setting('test.admin',true),'false')='true' $$;
 create table profiles(id uuid primary key,display_name text,phone text,photo_url text,role text default 'customer');
 create table wallets(user_id uuid primary key references profiles(id),balance integer default 0,status text default 'active',updated_at timestamptz);
 create table orders(id uuid primary key,user_id uuid,subtotal integer,delivery_fee integer,takeaway_fee integer,discount integer,vat integer,processing_fee integer,total integer,paid boolean,status text,payment_status text,created_at timestamptz default now());
 create table referral_codes(user_id uuid primary key references profiles(id),code text unique,created_at timestamptz default now());
 create table referrals(id uuid primary key default gen_random_uuid(),referrer_id uuid references profiles(id),referred_id uuid unique,status text default 'signed_up',qualifying_order_id uuid unique references orders(id),signed_up_at timestamptz default now(),qualified_at timestamptz,rewarded_at timestamptz,check(referrer_id<>referred_id));
 create table wallet_transactions(id uuid primary key default gen_random_uuid(),user_id uuid,type text,reason text,amount integer check(amount>0),balance_after integer,reference text unique,order_id uuid,description text);
 create table reward_points(user_id uuid,kind text,points integer,points_remaining integer,expires_at timestamptz,source text,referral_id uuid,unique(referral_id,source));
 create function reward_setting(text,integer) returns integer language sql as $$ select $2 $$;
 create function notify_user(uuid,text,text,text,uuid,boolean) returns void language sql as $$ select $$;
 create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
 `);
 await db.exec(fn('generate_referral_code')+fn('my_referral_code')+fn('handle_new_user')+fn('referral_qualify'));
 await db.exec(`create trigger signup after insert on auth.users for each row execute function handle_new_user();
 create trigger qualify after update on orders for each row execute function referral_qualify();`);
 await db.exec(fs.readFileSync('supabase/migrations/20261002000081_custom_partner_referrals.sql','utf8'));
 const ids = Array.from({length:6},(_,i)=>'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0'));
 const q = async(sql,params=[]) => (await db.query(sql,params)).rows;
 const uid=async(id,admin=false)=>{await q("select set_config('test.uid',$1,false),set_config('test.admin',$2,false)",[id,String(admin)]);};
 const signup=async(id,code='')=>q('insert into auth.users values($1,$2)',[id,JSON.stringify({display_name:id,referral_code:code})]);
 await signup(ids[0]); await signup(ids[1]); await q("update profiles set role='staff' where id=$1",[ids[1]]);
 await uid(ids[0]); await q('select my_referral_code()');
 const old=(await q('select code from referral_codes where user_id=$1',[ids[0]]))[0].code;
 assert.equal((await q("select customize_referral_code(' idris ') code"))[0].code,'IDRIS');
 for(const code of ['ABC','A-B-C','A'.repeat(21)]) await assert.rejects(q('select customize_referral_code($1)',[code]));
 await uid(ids[1]);
 await assert.rejects(q("select customize_referral_code('idris')"));
 await assert.rejects(q('select customize_referral_code($1)',[old]));
 await signup(ids[2],old);
 assert.equal((await q('select referrer_id,code_used from referrals where referred_id=$1',[ids[2]]))[0].code_used,old);
 const order=async(user,n,overrides={})=>{const id='10000000-0000-0000-0000-'+String(n).padStart(12,'0');const x={subtotal:3400,delivery:500,takeaway:200,discount:395,vat:0,processing:0,total:3705,...overrides};await q("insert into orders(id,user_id,subtotal,delivery_fee,takeaway_fee,discount,vat,processing_fee,total,paid,status,payment_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false,'New','pending')",[id,user,x.subtotal,x.delivery,x.takeaway,x.discount,x.vat,x.processing,x.total]);await q("update orders set paid=true,status='Completed',payment_status='paid' where id=$1",[id]);return id;};
 await order(ids[2],1);
 assert.deepEqual((await q('select source,points from reward_points order by source')).map(r=>[r.source,r.points]),[['referral_referred',100],['referral_referrer',100]]);
 await assert.rejects(q('select admin_set_partner_referrer($1,true,null)',[ids[0]]));
 await assert.rejects(q('select admin_partner_referrals()')); // staff cannot read/manage partner settings.
 await uid(ids[1],true);await q("select admin_set_partner_referrer($1,true,'DAVIDO')",[ids[0]]);
 await signup(ids[3],'davido');
 await q('select admin_set_partner_referrer($1,false,null)',[ids[0]]); // Snapshot survives later disable.
 const oid=await order(ids[3],2);
 assert.equal((await q('select balance from wallets where user_id=$1',[ids[0]]))[0].balance,300);
 assert.equal((await q('select subtotal,delivery_fee,takeaway_fee,discount,total from orders where id=$1',[oid]))[0].total,3705); // Commission base is 3400-395, not total.
 assert.equal((await q('select balance from wallets where user_id=$1',[ids[3]]))[0].balance,0);
 assert.equal((await q('select count(*)::int n from reward_points where referral_id=(select id from referrals where referred_id=$1)',[ids[3]]))[0].n,0);
 await q("update orders set status='New' where id=$1",[oid]); await q("update orders set status='Completed' where id=$1",[oid]);
 assert.equal((await q('select count(*)::int n from wallet_transactions'))[0].n,1);
 const report=(await q('select admin_partner_referrals() data'))[0].data;
 const r=report.referrals.find(r=>r.customer_id===ids[3]); assert.equal(r.base,3005);assert.equal(r.commission,300);assert.equal(r.credited,true);assert.equal(r.code_used,'DAVIDO');
 const partner=report.users.find(u=>u.id===ids[0]); assert.equal(partner.code,'DAVIDO'); assert.ok(partner.aliases.includes(old));
 await q('select admin_set_partner_referrer($1,false,null)',[ids[0]]);
 assert.equal((await q('select enabled from partner_referrers'))[0].enabled,false);
 await signup(ids[4],'DAVIDO');await order(ids[4],3);
 assert.equal((await q('select count(*)::int n from reward_points'))[0].n,4);
 assert.equal((await q('select partner_reward from referrals where referred_id=$1',[ids[4]]))[0].partner_reward,false);
 await q("select admin_set_partner_referrer($1,true,null)",[ids[0]]); await signup(ids[5],'DAVIDO');
 await q('select admin_set_partner_referrer($1,false,null)',[ids[0]]);
 await order(ids[5],4,{subtotal:400,delivery:500,takeaway:200,discount:900,processing:2300,total:2500});
 const zero=(await q('select commission_base,commission_amount,commission_transaction_id,partner_reward from referrals where referred_id=$1',[ids[5]]))[0];
 assert.equal(zero.commission_base,0); assert.equal(zero.commission_amount,0); assert.equal(zero.commission_transaction_id,null); assert.equal(zero.partner_reward,true);
 assert.equal((await q('select count(*)::int n from wallet_transactions'))[0].n,1);
 await uid(ids[2]);await assert.rejects(q('select admin_partner_referrals()')); await assert.rejects(q('select admin_set_partner_referrer($1,true,null)',[ids[0]]));
 await uid(ids[1]); await assert.rejects(q('select admin_partner_referrals()')); await assert.rejects(q('select admin_set_partner_referrer($1,true,null)',[ids[0]]));
 // Validate ACLs, not just the function's internal authorization check.
 await db.exec('set role authenticated');
 await assert.rejects(q('update partner_referrers set enabled=true'));
 await assert.rejects(q("insert into referral_code_aliases values('TAKEN',null)"));
 await db.exec('reset role');
 assert.equal((await q('select count(*)::int n from partner_referrers where enabled'))[0].n,0);
 console.log('PASS: ' + checkCount + ' database assertions — custom save/validation, duplicate refusal, alias resolution/reporting, normal rewards, attribution snapshot, commission base/clamp/floor, fee exclusion, partner-only rewards, replay idempotency, admin enable/disable, role denial, zero enabled defaults.');
 await db.close();
})().catch(e=>{console.error(e);process.exit(1)});
