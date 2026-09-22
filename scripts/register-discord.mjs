/** Registers/upserts only this application's /play command; does not bulk-delete other commands. */
const {DISCORD_CLIENT_ID:id,DISCORD_CLIENT_SECRET:secret,DISCORD_REGISTER_GUILD:guild}=process.env;
if(!id||!secret)throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env first.');
const tokenResponse=await fetch('https://discord.com/api/oauth2/token',{method:'POST',
  headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret,scope:'applications.commands.update'})});
if(!tokenResponse.ok)throw new Error(`Application credential exchange failed: HTTP ${tokenResponse.status}`);
const token=(await tokenResponse.json()).access_token;
const endpoint=`https://discord.com/api/v10/applications/${id}${guild?`/guilds/${guild}`:''}/commands`;
const command={name:'play',description:'Play Connect Four against JEV with verified community scores',type:1,
  options:[{type:3,name:'game',description:'Game to launch',required:false,choices:[{name:'Connect Four',value:'connect-four'}]}],
  ...(!guild?{integration_types:[0],contexts:[0]}:{})};
const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
if(!response.ok)throw new Error(`Command registration failed: HTTP ${response.status}`);
console.log('Registered /play. Configure the interactions endpoint at APP_ORIGIN/api/discord/interactions.');
console.log(`Guild install URL: https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(id)}&scope=applications.commands&integration_type=0`);
