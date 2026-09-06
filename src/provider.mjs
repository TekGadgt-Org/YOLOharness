import { ResponsesClient } from './responses.mjs';
export class ConfiguredProvider {
  constructor({credentials, url, model, fetch, authClient}={}) { if(!credentials?.accessToken||!url||!model) throw new TypeError('provider requires credentials, YOLO_RESPONSES_URL, and YOLO_MODEL'); this.credentials=credentials;this.url=url;this.model=model;this.fetch=fetch;this.authClient=authClient; }
  async next({messages,tools,signal}) {
    if (Number.isFinite(this.credentials.expiresAt) && this.credentials.expiresAt <= Date.now() && !this.authClient) {
      throw Object.assign(new Error('access token expired; reauthentication required'), { code: 'reauth_required' });
    }
    if (this.authClient && this.credentials.expiresAt && this.credentials.expiresAt <= Date.now()) this.credentials = await this.authClient.refresh(this.credentials, { signal });
    let streamedResult = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let result=null; let toolCall=null;
        for await(const event of new ResponsesClient({url:this.url,model:this.model,accessToken:this.credentials.accessToken,fetch:this.fetch}).respond({input:messages,tools,signal})) { if(event.type==='text_delta') { result=(result??'')+event.delta; streamedResult=result; } if(event.type==='tool_call') toolCall=event.call; if(event.type==='completed') { if(toolCall) return {tool_call:toolCall}; return {done:true,result:event.text??result??''}; } }
        return {done:true,result:result??''};
      } catch (error) {
        if (attempt === 0 && this.authClient && error.status === 401) {
          this.credentials = await this.authClient.refresh(this.credentials, { signal });
          continue;
        }
        if (error.status === 401 && !this.authClient) throw Object.assign(new Error('provider rejected access token; reauthentication required'), { code: 'reauth_required', status: 401 });
        if (streamedResult) error.partialResult = streamedResult;
        throw error;
      }
    }
  }
}
