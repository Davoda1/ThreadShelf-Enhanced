interface PositionedMessage {
  readonly turnIndex?: number;
  readonly reasoningTurnIndex?: number;
  readonly reasoning?: string;
}
/** Keep normalized archive turn positions even when the chat presentation omits
 * orphan reasoning turns. Initial counts are captured at mount, not after refresh. */
export function continuationSpeechIndex(
  messages: readonly PositionedMessage[],
  index: number,
  baseTurnIndex: number,
  initialMessageCount: number,
  initialTurnCount: number,
): number {
  const target = messages[index];
  if (target?.turnIndex !== undefined) return target.turnIndex;
  let next = baseTurnIndex;
  for (let i = 0; i <= index; i++) {
    if (i === initialMessageCount) next = Math.max(next, initialTurnCount);
    const message = messages[i];
    if (!message) break;
    const position = message.turnIndex ?? next + (message.reasoning ? 1 : 0);
    if (i === index) return position;
    next = Math.max(next, position + 1, (message.reasoningTurnIndex ?? -1) + 1);
  }
  return next;
}
