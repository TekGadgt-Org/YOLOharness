import { ResponsesClient } from './responses.mjs';
export class ConfiguredProvider {
  constructor({credentials, url, model, fetch}={}) { if(!credentials?.accessToken||!url||!model) throw new TypeError('provider requires credentials, YOLO_RESPONSES_URL, and YOLO_MODEL'); this.credentials=credentials;this.url=url;this.model=model;this.fetch=fetch; }
  async next({messages,tools,signal}) { let result=null; for await(const event of new ResponsesClient({url:this.url,model:this.model,accessToken:this.credentials.accessToken,fetch:this.fetch}).respond({input:messages,tools,signal})) { if(event.type==='text_delta') result=(result??'')+event.delta; if(event.type==='tool_call') return {tool_call:event.call}; if(event.type==='completed') return {done:true,result:event.text??result??''}; } return {done:true,result:result??''}; }
}
