/* 全コメントと返信を末尾まで取得し、IndexedDBへ保存して中断後も再開する。 */
(function (root) {
  'use strict';
  class CommentStore {
    constructor() { this.connection = null; }
    async open() {
      if (this.connection) return this.connection;
      this.connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('youtube-dopagaki-comments', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          const comments = db.createObjectStore('comments', { keyPath: ['videoId', 'id'] });
          comments.createIndex('video', 'videoId');
          db.createObjectStore('jobs', { keyPath: 'videoId' });
        };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = () => reject(new Error('コメントの保存領域を開けませんでした'));
      });
      return this.connection;
    }
    async load(videoId) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['comments', 'jobs'], 'readonly');
        const rows = tx.objectStore('comments').index('video').getAll(videoId);
        const job = tx.objectStore('jobs').get(videoId);
        tx.oncomplete = () => resolve({ comments: rows.result || [], job: job.result || null });
        tx.onerror = tx.onabort = () => reject(new Error('保存済みコメントを読み込めませんでした'));
      });
    }
    async loadPage(videoId, after=null) {
      const db=await this.open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['comments','jobs'],'readonly');const comments=[];
        const range=IDBKeyRange.bound([videoId,after||''],[videoId,'\uffff'],!!after,false);
        const cursor=tx.objectStore('comments').openCursor(range);
        const job=after?null:tx.objectStore('jobs').get(videoId);let more=false;
        cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(comments.length>=256){more=true;return;}comments.push(row.value);row.continue();};
        tx.oncomplete=()=>resolve({comments,job:job?.result||null,more,after:comments.at(-1)?.id||after});
        tx.onerror=tx.onabort=()=>reject(new Error('保存済みコメントを読み込めませんでした'));
      });
    }
    async reset(videoId, job) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['comments', 'jobs'], 'readwrite');
        const cursor = tx.objectStore('comments').index('video').openCursor(videoId);
        cursor.onsuccess = () => { const row = cursor.result; if (row) { row.delete(); row.continue(); } };
        tx.objectStore('jobs').put(job);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(new Error('再取得用の保存領域を準備できませんでした'));
      });
    }
    async commit(videoId, comments, job) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['comments', 'jobs'], 'readwrite');
        const rows = tx.objectStore('comments');
        for (const comment of comments) rows.put({ ...comment, videoId });
        tx.objectStore('jobs').put(job);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(new Error('コメントを保存できませんでした。空き容量を確認してください。全件取得は未完了です'));
      });
    }
  }
  class RuntimeStore {
    async call(operation,videoId,extra={}) {
      const response=await chrome.runtime.sendMessage({type:'COMET_COMMENT_CACHE',operation,videoId,...extra});
      if(!response?.ok)throw new Error(response?.error||'コメントの保存領域に接続できませんでした');
      return response.result;
    }
    async load(videoId) {
      const comments=[];let after=null,job=null;
      do {const page=await this.call('loadPage',videoId,{after});comments.push(...page.comments);if(!after)job=page.job;if(!page.more)break;after=page.after;} while(true);
      comments.sort((a,b)=>(a.order??0)-(b.order??0));
      return {comments,job};
    }
    reset(videoId,job){return this.call('reset',videoId,{job});}
    commit(videoId,comments,job){return this.call('commit',videoId,{comments,job});}
  }
  function bridgeRequest(operation, videoId, task, signal) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const finish = (error, result) => {
        clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => {
        window.postMessage({ type: 'COMET_COMMENT_REQUEST', operation: 'cancel', requestId }, location.origin);
        finish(new DOMException('取得を中断しました', 'AbortError'));
      };
      const receive = event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.type !== 'COMET_COMMENT_RESPONSE' || data.requestId !== requestId || data.videoId !== videoId) return;
        if (data.ok) finish(null, data.result); else finish(new Error(data.error || 'YouTubeから取得できませんでした'));
      };
      const timer = setTimeout(() => { window.postMessage({type:'COMET_COMMENT_REQUEST',operation:'cancel',requestId},location.origin); finish(new Error('YouTubeの応答が時間切れになりました。保存した続きから再開できます')); }, 45000);
      window.addEventListener('message', receive); signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) { abort(); return; }
      window.postMessage({ type:'COMET_COMMENT_REQUEST',operation,requestId,videoId,...task },location.origin);
    });
  }
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('取得を中断しました','AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); },ms);
    signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
  });
  async function fingerprint(value) {
    const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  }
  class CommentCollector {
    constructor({store=new RuntimeStore(),transport=bridgeRequest,onBatch=()=>{},onProgress=()=>{}}={}) {
      this.store=store; this.transport=transport; this.onBatch=onBatch; this.onProgress=onProgress; this.running=false;
    }
    stop() { this.controller?.abort(); }
    async load(videoId) { return this.store.load(videoId); }
    snapshot(status, error='') {
      return {videoId:this.videoId,status,total:this.total,count:this.known.size,replies:this.replyCount,pages:this.pages,pending:[...this.active.values(),...this.queue],seen:[...this.seen],updated:Date.now(),error};
    }
    wake() { for(const resolve of this.waiters) resolve(); this.waiters.clear(); }
    async request(operation, task={}) {
      for(let attempt=0;attempt<3;attempt++) {
        try { return await this.transport(operation,this.videoId,task,this.controller.signal); }
        catch(error) {
          if(error.name==='AbortError'||attempt===2||!/HTTP (429|5\d\d)|時間切れ|Failed to fetch|NetworkError|コメントの応答形式を読み取れません|本文データが欠け/.test(error.message)) throw error;
          await delay(1000*2**attempt,this.controller.signal);
        }
      }
    }
    async run(videoId, {restart=false}={}) {
      if(this.running) throw new Error('この動画のコメントを取得中です');
      this.running=true;this.controller=new AbortController();this.videoId=videoId;
      this.queue=[];this.active=new Map();this.seen=new Set();this.known=new Set();this.queued=new Set();this.waiters=new Set();this.tail=Promise.resolve();this.pages=0;this.total=null;this.replyCount=0;
      let failure,checkpointReady=false;
      const apply = action => { const result=this.tail.then(action); this.tail=result.catch(()=>{}); return result; };
      try {
        const saved=await this.store.load(videoId);
        if(!restart&&saved.job&&['paused','failed','running'].includes(saved.job.status)&&saved.job.pending?.length) {
          this.queue=saved.job.pending.slice();this.seen=new Set(saved.job.seen||[]);this.total=saved.job.total;this.pages=saved.job.pages||0;
          for(const comment of saved.comments) {this.known.add(comment.id);if(comment.parentId)this.replyCount++;}
          this.onBatch(saved.comments,{replace:true});
          checkpointReady=true;
        } else {
          this.onProgress({...this.snapshot('running'),phase:'準備中'});
          const start=await this.request('start');
          if(typeof start?.token!=='string'||!start.token) throw new Error('全コメントの取得開始先がありません');
          this.total=Number.isFinite(start.total)?start.total:null;
          this.queue=[{token:start.token,parentId:null,kind:'top'}];
          await this.store.reset(videoId,this.snapshot('running'));checkpointReady=true;this.onBatch([],{replace:true});
        }
        for(const task of this.queue) this.queued.add(await fingerprint(task.token));
        this.onProgress(this.snapshot('running'));
        const take = async () => {
          while(!this.controller.signal.aborted) {
            if(this.queue.length) {const task=this.queue.shift();this.active.set(task.token,task);return task;}
            if(!this.active.size) return null;
            await new Promise(resolve=>this.waiters.add(resolve));
          }
          return null;
        };
        const worker=async()=>{
          try {
            for(let task;(task=await take());) {
              await delay(150,this.controller.signal);
              const result=await this.request('page',task);
              if(this.controller.signal.aborted) break;
              await apply(async()=>{
                if(!Array.isArray(result?.comments)||!Array.isArray(result?.tasks)) throw new Error('コメントの応答が不正です。全件取得は未完了です');
                const fresh=[];
                for(const c of result.comments) {
                  if(typeof c.id!=='string'||typeof c.text!=='string'||typeof c.author!=='string'||!Number.isFinite(c.likes)) throw new Error('コメント本文の形式が不正です');
                  if(!this.known.has(c.id)&&!fresh.some(row=>row.id===c.id))fresh.push({...c,order:this.known.size+fresh.length});
                }
                const current=await fingerprint(task.token);const added=[];
                for(const child of result.tasks) {
                  if(typeof child.token!=='string'||!child.token) throw new Error('追加取得先が不正です');
                  const key=await fingerprint(child.token);
                  if(key===current) throw new Error('YouTubeが同じ取得先を繰り返しました。全件取得は未完了です');
                  if(this.seen.has(key)||this.queued.has(key)||added.some(row=>row.token===child.token)) {
                    if(child.kind==='top'||child.parentId===task.parentId)throw new Error('YouTubeの追加取得先が循環しました。全件取得は未完了です');
                    continue;
                  }
                  added.push(child);
                }
                const replyAdded=fresh.filter(c=>c.parentId).length;
                const checkpoint={...this.snapshot('running'),count:this.known.size+fresh.length,replies:this.replyCount+replyAdded,pages:this.pages+1,pending:[...this.active.values()].filter(t=>t.token!==task.token).concat(added,this.queue),seen:[...this.seen,current]};
                await this.store.commit(videoId,fresh,checkpoint);
                // 保存が成功した後だけ、処理済み扱いと次の取得先を公開する。
                for(const c of fresh)this.known.add(c.id);
                this.replyCount+=replyAdded;this.seen.add(current);this.active.delete(task.token);this.queue.unshift(...added);this.pages++;
                for(const child of added)this.queued.add(await fingerprint(child.token));
                this.onBatch(fresh,{replace:false});this.onProgress(this.snapshot('running'));this.wake();
              });
            }
          }catch(error){if(error.name!=='AbortError'&&!failure)failure=error;this.controller.abort();this.wake();}
        };
        await Promise.all([worker(),worker()]);await this.tail;
        if(failure) throw failure;
        const status=this.controller.signal.aborted?'paused':'exhausted';
        const final=this.snapshot(status);
        await this.store.commit(videoId,[],final);this.onProgress(final);return final;
      } catch(error) {
        await this.tail;
        const status=error.name==='AbortError'?'paused':'failed';
        const final=this.snapshot(status,error.name==='AbortError'?'':error.message);
        if(checkpointReady)try{await this.store.commit(videoId,[],final);}catch(saveError){final.error+=` ${saveError.message}`;}
        this.onProgress(final);return final;
      } finally {this.running=false;this.wake();}
    }
  }
  root.CometCommentCollector=CommentCollector;
  root.CometCommentStore=CommentStore;
  if(typeof module!=='undefined')module.exports={CommentCollector,CommentStore,RuntimeStore,bridgeRequest};
})(typeof globalThis!=='undefined'?globalThis:this);
