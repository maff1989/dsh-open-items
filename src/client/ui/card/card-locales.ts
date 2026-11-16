/**
 * Copy owned by the in-session card.
 *
 * A second locale namespace (`openItemsCard`) rather than more keys on the
 * inbox namespace: the card is a separate surface with its own vocabulary, the
 * inbox namespace is already at a stable size, and a separate namespace keeps
 * this milestone's dictionary additions off the page's inherited keys. The
 * dictionary follows the same rules as `../locales.ts`: flat keys, `{name}`
 * placeholders, explicit `.one`/`.other` counted pairs (the locale runtime has
 * no plural engine), and sentence-case English labels. The one product name is
 * `Open items` here exactly as on the page, the panel and the nav row.
 *
 * @module dsh-open-items/client/ui/card/card-locales
 */

/** Locale namespace of the in-session card. */
export const CARD_LOCALE_NAMESPACE = 'openItemsCard' as const

/** English dictionary (key source). */
export const cardEn = {
  // Frame ---------------------------------------------------------------------
  'card.toolTitle': 'Open items',
  'card.aria': 'Open item raised here',
  'card.raised.one': '{count} item raised',
  'card.raised.other': '{count} items raised',
  'card.andMore': 'and {count} more',
  'card.reviewAll': 'Review all {count}',
  'card.openInbox': 'Open in Open items',
  'card.openCandidates': 'Review in Candidates',
  'card.inferred': 'Inferred',
  'card.inferredNote': 'This is an inferred candidate, not a raised item. Review and confirm it in the Candidates tab.',
  'card.unknownKind': 'Item',
  'card.kind.decision': 'Decision',
  'card.kind.approval': 'Approval',
  'card.kind.question': 'Question',
  'card.kind.plan-review': 'Plan review',
  'card.kind.blocker': 'Blocker',
  'card.kind.risk': 'Risk',
  'card.kind.follow-up': 'Follow-up',
  'card.kind.task': 'Task',
  'card.optionsAria': 'Answer choices',
  'card.options.recommended': 'Recommended',

  // Controls ------------------------------------------------------------------
  'card.action.answer': 'Answer',
  'card.action.send': 'Send',
  'card.action.dismiss': 'Dismiss',
  'card.action.retry': 'Retry',
  'card.action.showAnswer': 'Show the answer',
  'card.action.hideAnswer': 'Hide the answer',
  'card.text.aria': 'Your answer',
  'card.sending': 'Sending…',

  // Receipts ------------------------------------------------------------------
  'card.receipt.applied': 'Answered · {time} — "{answer}". The agent will see this next step.',
  'card.receipt.recorded': 'Answered · {time} — "{answer}". Saved: the agent will see it when it next runs.',
  'card.receipt.answered': 'Answered · {time}',
  'card.receipt.answeredInInbox': 'Answered in Open items · {time}',
  'card.receipt.dismissed': 'Dismissed · {time}',
  'card.receipt.superseded': 'Superseded · {time}',
  'card.receipt.closed': 'Closed · {time}',
  'card.receipt.noLongerOpen': 'This item is no longer open.',

  // Never-render / disabled explanations -------------------------------------
  'card.conflict': 'This item was already answered in another window.',
  'card.offline': "Can't reach the harness. Your answer was not sent.",
  'card.readOnly': 'Read-only session: the answer controls are disabled.',
  'card.subagent': 'A subagent session cannot answer items; answer it in the parent session.',
  'card.notOwned': 'This item was raised earlier and is answered in Open items.',
  'card.approvalsInInbox': 'Approvals are answered in Open items.',
  'card.planPointer': "Plan reviews are answered at the session's own review card.",

  // Fallbacks -----------------------------------------------------------------
  'card.legacy': 'This build of Open items cannot show this card.',
  'card.errorDetail': 'The tool result recorded the failure; nothing here is answerable.',

  // Typed failures ------------------------------------------------------------
  'card.failure.not-found': 'This item no longer exists. Open the inbox to check the register.',
  'card.failure.bad-request': 'The harness refused this answer.',
  'card.failure.session-archived': 'The session is archived, so the answer was not applied.',
  'card.failure.agent-unavailable': 'The agent is unavailable, so the answer was not sent.',
  'card.failure.outcome-unknown': 'The outcome is unknown. Open items shows what landed.',
  'card.failure.limit-reached': 'The inbox is full, so this item was not recorded.',
  'card.failure.forbidden': 'This client does not own the session, so it cannot answer.',
  'card.failure.unknown': 'The answer was not sent.',
} satisfies Record<string, string>

/** Supported card copy keys. */
export type OpenItemsCardKey = keyof typeof cardEn

/** Literal namespace of the card dictionary. */
export type OpenItemsCardNamespace = typeof CARD_LOCALE_NAMESPACE

/** Simplified Chinese dictionary, checked key-for-key against {@link cardEn}. */
export const cardZh = {
  'card.toolTitle': '待处理事项',
  'card.aria': '此处提出的待处理事项',
  'card.raised.one': '提出了 {count} 项',
  'card.raised.other': '提出了 {count} 项',
  'card.andMore': '另有 {count} 项',
  'card.reviewAll': '查看全部 {count} 项',
  'card.openInbox': '在待处理事项中打开',
  'card.openCandidates': '在“候选”中查看',
  'card.inferred': '推断',
  'card.inferredNote': '这是一个推断出的候选，并非智能体主动提出。请在“候选”标签页中查看并确认。',
  'card.unknownKind': '事项',
  'card.kind.decision': '决定',
  'card.kind.approval': '审批',
  'card.kind.question': '问题',
  'card.kind.plan-review': '计划审阅',
  'card.kind.blocker': '阻塞',
  'card.kind.risk': '风险',
  'card.kind.follow-up': '后续',
  'card.kind.task': '任务',
  'card.optionsAria': '回答选项',
  'card.options.recommended': '推荐',

  'card.action.answer': '回答',
  'card.action.send': '发送',
  'card.action.dismiss': '忽略',
  'card.action.retry': '重试',
  'card.action.showAnswer': '查看答复',
  'card.action.hideAnswer': '隐藏答复',
  'card.text.aria': '你的回答',
  'card.sending': '发送中…',

  'card.receipt.applied': '已答复 · {time} — “{answer}”。智能体将在下一步看到。',
  'card.receipt.recorded': '已答复 · {time} — “{answer}”。已保存：智能体下次运行时会看到。',
  'card.receipt.answered': '已答复 · {time}',
  'card.receipt.answeredInInbox': '已在待处理事项中答复 · {time}',
  'card.receipt.dismissed': '已忽略 · {time}',
  'card.receipt.superseded': '已被替代 · {time}',
  'card.receipt.closed': '已关闭 · {time}',
  'card.receipt.noLongerOpen': '此事项已不再待处理。',

  'card.conflict': '此事项已在另一个窗口中答复。',
  'card.offline': '无法连接宿主，你的回答未发送。',
  'card.readOnly': '只读会话：回答控件已禁用。',
  'card.subagent': '子会话无法回答事项，请在父会话中回答。',
  'card.notOwned': '此事项在更早时提出，请在待处理事项中回答。',
  'card.approvalsInInbox': '审批请在待处理事项中回答。',
  'card.planPointer': '计划审阅请在会话自带的审阅卡片中回答。',

  'card.legacy': '当前版本的待处理事项无法显示此卡片。',
  'card.errorDetail': '工具结果已记录失败，此处没有任何可回答的内容。',

  'card.failure.not-found': '此事项已不存在，请在待处理事项中查看记录。',
  'card.failure.bad-request': '宿主拒绝了此回答。',
  'card.failure.session-archived': '会话已归档，回答未应用。',
  'card.failure.agent-unavailable': '智能体不可用，回答未发送。',
  'card.failure.outcome-unknown': '结果未知，请在待处理事项中查看实际状态。',
  'card.failure.limit-reached': '待处理事项已满，此事项未记录。',
  'card.failure.forbidden': '此客户端不拥有该会话，无法回答。',
  'card.failure.unknown': '回答未发送。',
} satisfies Record<OpenItemsCardKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the in-session open-items card. */
    openItemsCard: OpenItemsCardKey
  }
}
