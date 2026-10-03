/* YouTubeのコメント応答を本文・返信・追加取得先に分解する。外部通信は行わない。 */
(function (root) {
  'use strict';
  function* objects(value) {
    const stack = [value];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node)) yield node;
      const values = Array.isArray(node) ? node : Object.values(node);
      for (let i = values.length - 1; i >= 0; i--) if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
    }
  }
  function text(value) {
    if (typeof value === 'string') return value;
    if (!value) return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(r => r.text || '').join('');
    return typeof value.content === 'string' ? value.content : '';
  }
  function token(endpoint) {
    for (const node of objects(endpoint)) {
      if (typeof node.continuationCommand?.token === 'string') return node.continuationCommand.token;
      if (typeof node.nextContinuationData?.continuation === 'string') return node.nextContinuationData.continuation;
      if (typeof node.reloadContinuationData?.continuation === 'string') return node.reloadContinuationData.continuation;
    }
    return null;
  }
  function continuation(renderer) {
    for (const item of renderer?.continuations || []) { const t = token(item); if (t) return t; }
    for (const key of ['contents', 'items', 'rows', 'subThreads']) for (const item of renderer?.[key] || []) {
      const value = item.continuationItemRenderer || item.continuationItemViewModel;
      const t = token(value); if (t) return t;
    }
    return null;
  }
  function initial(data) {
    for (const node of objects(data)) {
      const section = node.itemSectionRenderer;
      if (section?.targetId === 'comments-section' || section?.sectionIdentifier === 'comment-item-section') {
        const value = continuation(section); if (value) return value;
      }
    }
    throw new Error('YouTubeからコメントの追加取得先を取得できませんでした。コメントが無効な動画では取得できません');
  }
  function header(data) {
    for (const node of objects(data)) if (node.commentsHeaderRenderer) {
      const h = node.commentsHeaderRenderer;
      const menu = h.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems;
      // WEBクライアントの2番目は「新しい順」。人気順の先頭だけで全件と判定しない。
      const next = token(menu?.[1]?.serviceEndpoint) || token(menu?.[1]);
      if (!next) throw new Error('「新しい順」の取得先が見つかりません。YouTubeのコメント形式を確認してください');
      const label = text(h.countText) || text(h.commentsCount);
      const match = label.normalize('NFKC').replace(/[,\s]/g, '').match(/(\d+(?:\.\d+)?)(万|億|[kKmM])?/);
      const total = match ? Math.round(Number(match[1]) * ({万:10000,億:100000000,k:1000,K:1000,m:1000000,M:1000000}[match[2]] || 1)) : null;
      return { token: next, total };
    }
    throw new Error('コメントのヘッダーを取得できませんでした。ログイン確認やYouTubeのエラーを確認してください');
  }
  function page(data, parent = null) {
    if (data.error) throw new Error(`YouTube応答エラー: ${data.error.message || data.error.code || '不明'}`);
    const entities = new Map();
    for (const mutation of data.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const entity = mutation.payload?.commentEntityPayload;
      if (entity) entities.set(mutation.entityKey, entity);
    }
    const comments = [], replies = [], next = [], messages = [];
    let recognized = false, models = 0;
    const normalize = (renderer, model, owner) => {
      let id, content, author, likes;
      if (model) {
        models++;
        const entity = entities.get(model.commentKey);
        if (!entity) throw new Error('コメントの本文データが欠けています。途中取得として停止します');
        id = entity.properties?.commentId;
        content = text(entity.properties?.content);
        author = entity.author?.displayName || '';
        likes = entity.toolbar?.likeCountA11y || entity.toolbar?.likeCountNotliked || '0';
      } else if (renderer) {
        id = renderer.commentId; content = text(renderer.contentText);
        author = text(renderer.authorText); likes = text(renderer.voteCount);
      }
      if (!id) return null;
      const raw = String(likes).normalize('NFKC').replace(/,/g, '');
      const number = raw.match(/(\d+(?:\.\d+)?)\s*(万|千|[kKmM])?/);
      const likeCount = number ? Math.round(Number(number[1]) * ({万:10000,千:1000,k:1000,K:1000,m:1000000,M:1000000}[number[2]] || 1)) : 0;
      const comment = { id, text: content, author, likes: likeCount, parentId: owner || null };
      comments.push(comment); return comment;
    };
    const replySection = (section, owner) => {
      for (const key of ['contents', 'items', 'subThreads']) for (const child of section?.[key] || []) {
        if (child.continuationItemRenderer || child.continuationItemViewModel) {
          const value = token(child); if (value) replies.push({ token: value, parentId: owner, kind: 'reply' });
        } else visit(child, owner);
      }
      for (const item of section?.continuations || []) {
        const value = token(item); if (value) replies.push({ token: value, parentId: owner, kind: 'reply' });
      }
    };
    const visit = (item, owner) => {
      if (item.continuationItemRenderer || item.continuationItemViewModel) {
        const value = token(item); if (value) next.push({ token: value, parentId: owner, kind: owner ? 'reply' : 'top' });
        return;
      }
      if (item.messageRenderer) { messages.push(text(item.messageRenderer.text)); return; }
      const thread = item.commentThreadRenderer;
      if (thread) {
        const model = thread.commentViewModel?.commentViewModel || thread.commentViewModel;
        const record = normalize(thread.comment?.commentRenderer || thread.commentRenderer, model, owner);
        if (thread.replies?.commentRepliesRenderer) {
          if (!record) throw new Error('返信の親コメントが取得できませんでした');
          replySection(thread.replies.commentRepliesRenderer, record.id);
        }
      } else if (item.commentViewModel || item.commentRenderer) normalize(item.commentRenderer, item.commentViewModel, owner);
    };
    const commands = [...(data.onResponseReceivedEndpoints || []), ...(data.onResponseReceivedActions || [])];
    for (const command of commands) {
      const c = command.reloadContinuationItemsCommand || command.appendContinuationItemsAction;
      if (!c) continue;
      if (c.targetId && !c.targetId.startsWith('comments-section') && !c.targetId.startsWith('comment-replies')) continue;
      // 実応答では、返信の末尾だけ配列そのものが省略される。本文ページの欠落とは区別する。
      if (c.continuationItems === undefined && c.targetId?.startsWith('comment-replies')) { recognized = true; continue; }
      if (!Array.isArray(c.continuationItems)) continue;
      recognized = true;
      for (const item of c.continuationItems) visit(item, parent);
    }
    const legacy = data.continuationContents?.commentSectionContinuation || data.continuationContents?.commentRepliesContinuation;
    if (legacy) {
      recognized = true;
      for (const item of legacy.contents || legacy.items || []) visit(item, parent);
      const value = continuation(legacy); if (value) next.push({ token: value, parentId: parent, kind: parent ? 'reply' : 'top' });
    }
    if (!recognized) throw new Error('コメントの応答形式を読み取れませんでした。全件取得は未完了です');
    return { comments, tasks: replies.concat(next), messages, models };
  }
  const api = Object.freeze({ initial, header, page, text, token });
  root.CometCommentAPI = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
