/* 設定の初期化と、拡張専用IndexedDBへのコメント・再開位置の保存。 */
importScripts('comment-collector.js');
(() => {
  'use strict';
  const store=new CometCommentStore();
  chrome.runtime.onInstalled.addListener(async()=>{
    const data=await chrome.storage.local.get('settings');
    if(!data.settings)await chrome.storage.local.set({settings:{}});
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.type!=='COMET_COMMENT_CACHE')return;
    if(sender.id!==chrome.runtime.id||!sender.tab?.url?.startsWith('https://www.youtube.com/')||!/^[\w-]{11}$/.test(message.videoId)){
      respond({ok:false,error:'コメント保存要求の送信元が不正です'});return;
    }
    (async()=>{
      try{
        let result;
        if(message.operation==='loadPage')result=await store.loadPage(message.videoId,message.after||null);
        else if(message.operation==='reset'&&message.job?.videoId===message.videoId)result=await store.reset(message.videoId,message.job);
        else if(message.operation==='commit'&&Array.isArray(message.comments)&&message.job?.videoId===message.videoId)result=await store.commit(message.videoId,message.comments,message.job);
        else throw new Error('コメント保存操作が不正です');
        respond({ok:true,result});
      }catch(error){respond({ok:false,error:error.message});}
    })();return true;
  });
})();
