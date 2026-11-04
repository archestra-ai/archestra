/** Additive local fixture for the team-spend prototype. Never targets shared databases. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { hashPassword } from "better-auth/crypto";

dotenv.config({path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true});
const connectionString = process.env.ARCHESTRA_DATABASE_URL;
const target = new URL(connectionString);
if (!['postgres:','postgresql:'].includes(target.protocol) || (target.search && target.search !== '?schema=public') || target.hash || !['localhost','127.0.0.1'].includes(target.hostname) || target.port !== '55471' || target.pathname !== '/archestra_t2151') throw new Error('Only the dedicated local archestra_t2151 database on port 55471 is allowed; only the optional schema=public URL parameter is accepted.');
const db = new pg.Client({connectionString});
await db.connect();
const org = 'synthetic-t2151';
const now = new Date();
const ago = days => new Date(now.getTime()-days*86400000);
try {
 await db.query('BEGIN');
 await db.query("SELECT pg_advisory_xact_lock(2151001)");
 if ((await db.query('SELECT id FROM organization WHERE id=$1',[org])).rowCount) {
   await db.query(`INSERT INTO limit_model_usage (limit_id,model)
    SELECT b.limit_id,b.model FROM limit_billing_usage b JOIN limits l ON l.id=b.limit_id
    JOIN team t ON t.id=l.entity_id AND l.entity_type='team'
    WHERE t.organization_id=$1 AND NOT EXISTS (SELECT 1 FROM limit_model_usage m WHERE m.limit_id=b.limit_id AND m.model=b.model)`,[org]);
   console.log('Synthetic scenarios already exist; ensured additive usage companion rows.');
   await db.query('COMMIT');
 } else {
  await db.query('INSERT INTO organization (id,name,slug,created_at,onboarding_complete,onboarding_survey_completed_at) VALUES ($1,$2,$1,$3,true,$3)',[org,'Synthetic · Team Spend Lab',ago(90)]);
  const password = await hashPassword('synthetic-spend-demo');
  const people = ['admin','lead','member','alex','blair','casey','devon','ellis','frankie','gray','harper','indigo','jules','kai','lane'];
  for (const [index, person] of people.entries()) {
   const id=`synthetic-t2151-${person}`;
   await db.query('INSERT INTO "user" (id,name,email,email_verified,role,created_at,updated_at) VALUES ($1,$2,$3,true,$4,$5,$5)',[id,`Synthetic ${person}`,`spend-${person}@example.com`,index===0?'admin':'user',ago(90)]);
   await db.query('INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ($1,$1,\'credential\',$1,$2,$3,$3)',[id,password,ago(90)]);
   await db.query('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,$2,$1,$3,$4)',[id,org,index===0?'admin':'member',ago(90)]);
  }
  const specs=[
   ['engineering','Engineering',null,3000,'1m','hard'],
   ['platform','Platform','engineering',800,'1m','hard'],
   ['product','Product','engineering',18,'1w','hard'],
   ['research','Research','engineering',60,'1m','soft'],
   ['support','Support',null,10,'1w','hard'],
   ['operations','Operations',null,100,'24h','hard'],
   ['new-team','New team',null,500,'1m','hard'],
   ['no-limit','Exploration',null,null,'1m','hard'],
  ];
  const teamId=key=>`synthetic-t2151-team-${key}`;
  for(const [key,name,parent] of specs) {
   await db.query('INSERT INTO team (id,name,description,organization_id,parent_team_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',[teamId(key),`Synthetic · ${name}`,'Synthetic local spend scenario',org,parent?teamId(parent):null,'synthetic-t2151-admin',ago(key==='new-team'?1:90)]);
  }
  let memberships=0;
  for(const [idx,[key]] of specs.entries()) {
   const names = key==='new-team'?['lane']:['member',...people.slice(3+idx,6+idx)];
   if(key==='engineering') names.push('lead');
   for(const person of new Set(names)) {
    await db.query('INSERT INTO team_member (id,team_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),teamId(key),`synthetic-t2151-${person}`,person==='lead'?'admin':'member',ago(key==='new-team'?0.5:60)]);memberships++;
   }
  }
  const agent=randomUUID();
  await db.query('INSERT INTO agents (id,organization_id,name,agent_type,scope,author_id) VALUES ($1,$2,$3,\'llm_proxy\',\'organization\',$4)',[agent,org,'Synthetic spend generator','synthetic-t2151-admin']);
  const models=[['gpt-4.1','openai'],['claude-sonnet-4-5','anthropic'],['gemini-2.5-flash','gemini']];
  const rows=[];
  for(let day=0;day<75;day++) for(let team=0;team<specs.length;team++) {
   if(specs[team][0]==='new-team') continue;
   const count=1+(day+team)%5;
   for(let call=0;call<count;call++) {
    const [model,provider]=models[(day+call+team)%3];
    const mode=(day+call+team)%7===0?'subscription':'metered';
    const cost=(day+call)%29===0?null:Number(((team+1)*(call+1)*0.19+(75-day)*0.003).toFixed(4));
    const date=ago(day+(call+1)/12);
    const user=day>5?'lane':people[3+(team+call)%12];
    const billedTeam=teamId(specs[team][0]);
    const tokens=1000+(day*79+call*211+team*100)%15000;
    rows.push({id:randomUUID(),team:billedTeam,model,provider,mode,cost,date,tokens,user:`synthetic-t2151-${user}`});
   }
  }
  // Membership-only spend must not appear in New team. Null payer is deliberately excluded.
  rows.push({id:randomUUID(),team:null,model:'gpt-4.1',provider:'openai',mode:'metered',cost:123,date:ago(2),tokens:5000,user:'synthetic-t2151-lane'});
  for(const row of rows) await db.query('INSERT INTO interactions (id,profile_id,user_id,billing_team_id,type,model,billing_mode,cost,input_tokens,output_tokens,cache_read_tokens,request,response,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[row.id,agent,row.user,row.team,({openai:"openai:chatCompletions",anthropic:"anthropic:messages",gemini:"gemini:generateContent"}[row.provider]),row.model,row.mode,row.cost,row.tokens,Math.round(row.tokens/4),Math.round(row.tokens/2),JSON.stringify({model:row.model,messages:[{role:'user',content:'Synthetic local usage fixture'}]}),JSON.stringify({}),row.date]);
  for(const [key,,parent,cap,period,behavior] of specs) {
   if(cap===null) continue;
   const id=randomUUID(); const reset=ago(period==='24h'?0.4:period==='1w'?3:14);
   await db.query('INSERT INTO limits (id,entity_type,entity_id,limit_type,limit_value,behavior,cleanup_interval,last_cleanup,created_at,updated_at) VALUES ($1,\'team\',$2,\'token_cost\',$3,$4,$5,$6,$6,$6)',[id,teamId(key),cap,behavior,period,reset]);
   const charged=new Set([teamId(key),...specs.filter(s=>s[2]===key).map(s=>teamId(s[0]))]);
   for(const [model] of models) {
    const group=rows.filter(r=>charged.has(r.team)&&r.mode==='metered'&&r.model===model&&r.date>=reset);
    await db.query('INSERT INTO limit_model_usage (limit_id,model) VALUES ($1,$2)',[id,model]);
    const total=group.reduce((n,r)=>n+(r.cost??0),0);
    await db.query('INSERT INTO limit_billing_usage (limit_id,model,cost,incomplete) VALUES ($1,$2,$3,$4)',[id,model,total,group.filter(r=>r.cost===null).length]);
   }
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({organization:org,teams:specs.length,users:people.length,memberships,interactions:rows.length,days:75,accounts:['spend-admin@example.com','spend-lead@example.com','spend-member@example.com'],password:'synthetic-spend-demo'}));
 }
 // Additive permission-review accounts, also installed on existing fixtures.
 await db.query('BEGIN');
 await db.query("SELECT pg_advisory_xact_lock(2151001)");
 await db.query('INSERT INTO organization_role (id,organization_id,role,name,permission) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',['synthetic-t2151-cost-reader-role',org,'synthetic_cost_reader','Synthetic cost reader',JSON.stringify({llmCost:['read']})]);
 await db.query('INSERT INTO organization_role (id,organization_id,role,name,permission) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',['synthetic-t2151-people-reader-role',org,'synthetic_people_reader','Synthetic people reader',JSON.stringify({llmCost:['read'],member:['read']})]);
 for (const [person,team,role] of [['childlead','product','member'],['unrelatedlead','support','member'],['costreader',null,'synthetic_cost_reader'],['costlead','product','synthetic_cost_reader'],['peoplereader',null,'synthetic_people_reader']]) {
  const id=`synthetic-t2151-${person}`;
  if ((await db.query('SELECT id FROM "user" WHERE id=$1',[id])).rowCount) continue;
  const password=await hashPassword('synthetic-spend-demo');
  await db.query('INSERT INTO "user" (id,name,email,email_verified,role,created_at,updated_at) VALUES ($1,$2,$3,true,\'user\',$4,$4)',[id,`Synthetic ${person}`,`spend-${person}@example.com`,now]);
  await db.query('INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ($1,$1,\'credential\',$1,$2,$3,$3)',[id,password,now]);
  await db.query('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,$2,$1,$3,$4)',[id,org,role,now]);
  if (team) await db.query('INSERT INTO team_member (id,team_id,user_id,role,created_at) VALUES ($1,$2,$3,\'admin\',$4)',[randomUUID(),`synthetic-t2151-team-${team}`,id,now]);
 }
 // Identity fixtures are historical, before the seeded allowance resets. They
 // therefore change historical charts without rewriting current budget counters.
 for (const [index,team] of ['product','support'].entries()) {
  const serviceId=`21510000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
  await db.query('INSERT INTO service_accounts (id,organization_id,name,role,team_id,disabled) VALUES ($1,$2,$3,\'member\',$4,true) ON CONFLICT DO NOTHING',[serviceId,org,`Synthetic ${team} batch worker`,`synthetic-t2151-team-${team}`]);
  for (const [scenario,user,service,cost,mode] of [
   [1,null,null,12,'metered'],[2,null,serviceId,8,'metered'],
   [3,'synthetic-t2151-alex',null,4,'metered'],[4,null,serviceId,5,'subscription'],
  ]) {
   const id=`21510000-0000-4000-9000-${String(index*10+scenario).padStart(12,'0')}`;
   await db.query(`INSERT INTO interactions (id,profile_id,user_id,service_account_id,billing_team_id,type,model,billing_mode,cost,input_tokens,output_tokens,request,response,created_at)
    SELECT $1,id,$2,$3,$4,'openai:chatCompletions','gpt-4.1',$5,$6,1200,300,$7::jsonb,'{}'::jsonb,$8 FROM agents WHERE organization_id=$9 AND name='Synthetic spend generator'
    ON CONFLICT DO NOTHING`,[id,user,service,`synthetic-t2151-team-${team}`,mode,cost,JSON.stringify({model:'gpt-4.1',messages:[{role:'user',content:'Synthetic recorded-identity fixture; a shared personal credential remains attributed to its owner.'}]}),ago(21+scenario/24),org]);
  }
 }
 await db.query('COMMIT');
} catch(error) {await db.query('ROLLBACK');throw error;} finally {await db.end();}
