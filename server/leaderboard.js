import {rows,one} from './db.js';
import {contextFor} from './auth.js';
import {assert,canonical,hmac,equal,int,now,HttpError} from './util.js';
export async function signCursor(env,payload) {
  const value=btoa(JSON.stringify(payload));return value+'.'+await hmac(env.APP_SECRET,`cursor:${value}`);
}
export async function readCursor(env,token) {
  assert(typeof token==='string'&&token.length<3000,400,'INVALID_CURSOR');
  const [value,signature,...extra]=token.split('.');
  assert(!extra.length&&equal(signature,await hmac(env.APP_SECRET,`cursor:${value}`)),400,'INVALID_CURSOR');
  try{return JSON.parse(atob(value));}catch{throw new HttpError(400,'INVALID_CURSOR');}
}
export async function leaderboard(env,session,url) {
  const scope=url.searchParams.get('scope')||'world',difficulty=url.searchParams.get('difficulty')||'normal';
  assert(['world','server','channel'].includes(scope),400,'INVALID_SCOPE');
  assert(['easy','normal','hard','jev'].includes(difficulty),400,'INVALID_DIFFICULTY');
  const humanDisc=int(url.searchParams.get('humanDisc'),1,2,1),limit=int(url.searchParams.get('limit'),1,100,50);
  const context=scope==='world'?null:await contextFor(env,session,url.searchParams.get('contextId'));
  let opponentVersion=url.searchParams.get('opponentVersion');
  if(!opponentVersion)opponentVersion=(await one(env,'SELECT opponent_version FROM matches WHERE difficulty=? ORDER BY started_at DESC LIMIT 1',difficulty))?.opponent_version||null;
  assert(!opponentVersion||/^[a-f0-9]{20}$/.test(opponentVersion),400,'INVALID_OPPONENT_VERSION');
  const cohort={scope,difficulty,humanDisc,opponentVersion,context:scope==='world'?null:scope==='server'?context.guild_id:context.channel_id};
  let offset=0,asOf=now(env);
  if(url.searchParams.has('cursor')) {
    const c=await readCursor(env,url.searchParams.get('cursor'));
    assert(canonical(c.cohort)===canonical(cohort)&&Number.isInteger(c.offset)&&c.offset>=0&&c.offset<=100000&&Number.isFinite(c.asOf)&&c.asOf<=now(env),400,'CURSOR_COHORT_MISMATCH');
    offset=c.offset;asOf=c.asOf;
  }
  const filter=scope==='world'?'':scope==='server'?' AND m.guild_id=?':' AND m.channel_id=?';
  const params=[difficulty,humanDisc,opponentVersion,asOf,...(scope==='world'?[]:[cohort.context])];
  const sql=`WITH base AS (
    SELECT m.user_id,m.result,m.finished_at,m.id,u.display_name,
      SUM(CASE WHEN result='win' THEN 0 ELSE 1 END) OVER(PARTITION BY m.user_id ORDER BY m.finished_at,m.id) AS streak_group
    FROM matches m JOIN users u ON u.id=m.user_id
    WHERE m.eligible=1 AND m.difficulty=? AND m.human_disc=? AND m.opponent_version=? AND m.finished_at<=? ${filter}
  ), streaks AS (
    SELECT user_id,streak_group,SUM(result='win') AS streak FROM base GROUP BY user_id,streak_group
  ), best AS (SELECT user_id,MAX(streak) AS bestStreak FROM streaks GROUP BY user_id),
  latest_streak AS (SELECT s.user_id,s.streak FROM streaks s WHERE s.streak_group=(SELECT MAX(b.streak_group) FROM base b WHERE b.user_id=s.user_id)),
  totals AS (
    SELECT user_id,display_name,COUNT(*) AS games,SUM(result='win') AS wins,SUM(result='loss') AS losses,SUM(result='draw') AS draws,
      (SUM(result='win')+0.5*SUM(result='draw'))/COUNT(*) AS resultRate FROM base GROUP BY user_id
  ), ranked AS (
    SELECT t.*,best.bestStreak,latest_streak.streak AS currentStreak,
      CASE WHEN games>=20 THEN DENSE_RANK() OVER(ORDER BY (games>=20) DESC,resultRate DESC,wins DESC,games DESC) ELSE NULL END AS rank
    FROM totals t JOIN best USING(user_id) JOIN latest_streak USING(user_id)
  ) SELECT * FROM ranked ORDER BY (games>=20) DESC,resultRate DESC,wins DESC,games DESC,user_id LIMIT ? OFFSET ?`;
  const found=await rows(env,sql,...params,limit+1,offset),more=found.length>limit;
  const output=found.slice(0,limit).map(r=>({rank:r.rank,playerId:r.user_id,displayName:r.display_name,games:r.games,wins:r.wins,
    losses:r.losses,draws:r.draws,resultRate:r.resultRate,currentStreak:r.currentStreak,bestStreak:r.bestStreak,provisional:r.games<20}));
  const availableVersions=(await rows(env,'SELECT opponent_version,MAX(started_at) AS latest FROM matches WHERE difficulty=? AND eligible=1 GROUP BY opponent_version ORDER BY latest DESC LIMIT 20',difficulty)).map(r=>r.opponent_version);
  return {scope,difficulty,humanDisc,opponentVersion,asOf,minimumGames:20,rows:output,availableVersions,
    nextCursor:more?await signCursor(env,{cohort,offset:offset+limit,asOf}):null};
}
