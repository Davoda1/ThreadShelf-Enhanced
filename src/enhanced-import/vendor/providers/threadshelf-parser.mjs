// Adapted from ThreadShelf 1.2.3, MIT; see ThreadShelf-LICENSE.txt.
                                            

// --- Public types ---

                               
                       
                         
                         
 

                              
                                         
                          
 

                                  
                         
                          
 

                                      
                       
                         
                             
 

// --- Public API ---

export const parseExport = (input         , options               = {})                  => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: parsed.conversations.flatMap((c) => c.turns) };
};

export const parseConversationGroups = (
  input         ,
  options               = {},
)              => {
  return parseConversations(input, options);
};

export const listConversationsFromExport = (
  input         ,
  options               = {},
)                                                           => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { conversations: [], error: parsed.error };
  return {
    conversations: parsed.conversations.map((c) => ({
      key: c.key,
      title: c.title,
      turnCount: c.turns.length,
    })),
  };
};

export const getConversationFromExport = (
  input         ,
  conversationKey        ,
  options               = {},
)                                                        => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { conversation: null, error: parsed.error };

  const conversation = conversationKey
    ? parsed.conversations.find((entry) => entry.key === conversationKey)
    : parsed.conversations[0];

  if (!conversation) {
    return { conversation: null, error: `Conversation not found: ${conversationKey}` };
  }
  return { conversation };
};

export const parseFile = async (
  filePath        ,
  options               = {},
)                           => {
  const fs = await import('fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return parseExport(content, options);
};

export const parseGoogleAIStudio = (
  input         ,
  options               = {},
)                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  const result = buildGoogleConversation(parsed.data          , options);
  return flattenParseResult(result);
};

export const parseAnthropic = (input         , options               = {})                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildAnthropicConversations(parsed.data, options).flatMap((c) => c.turns) };
};

export const parseOpenAI = (input         , options               = {})                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildOpenAIConversations(parsed.data, options).flatMap((c) => c.turns) };
};

export const parseOpenRouter = (input         , options               = {})                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return flattenParseResult(buildOpenRouterConversation(parsed.data          , options));
};

export const parseLMStudio = (input         , options               = {})                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return flattenParseResult(buildLMStudioConversation(parsed.data          , options));
};

export const parseGrok = (input         , options               = {})                  => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildGrokConversations(parsed.data          , options).flatMap((c) => c.turns) };
};

// --- Format detection ---

                      
                      
               
            
                
               
          
              

export const detectProvider = (data         )           => {
  if (isGoogleAIStudio(data)) return 'google-ai-studio';
  if (isGrokFormat(data)) return 'grok';
  if (isAnthropicFormat(data)) return 'anthropic';
  if (isOpenAIFormat(data)) return 'openai';
  if (isOpenRouterFormat(data)) return 'openrouter';
  if (isLMStudioFormat(data)) return 'lm-studio';
  return 'unknown';
};

// --- Internal types ---

                        
                                 
                                     
                               
 

                                      

// --- Format detection helpers ---

const isGoogleAIStudio = (data         )          => {
  const d = data          ;
  return (
    (!!d?.chunkedPrompt && Array.isArray((d.chunkedPrompt          )?.chunks)) ||
    (!!d?.imagenPrompt && Array.isArray((d.imagenPrompt          )?.imagenTurns))
  );
};

const isAnthropicFormat = (data         )          => {
  if (Array.isArray(data) && data.length > 0 && (data[0]          )?.chat_messages != null)
    return true;
  if (Array.isArray(data)) return false;
  const d = data          ;
  if (Array.isArray(d?.chat_messages)) return true;
  // Project conversation files in current Anthropic exports use
  // `{ project, messages: [{ role, content: { content } }] }` rather than the
  // top-level export's `chat_messages` array.
  if (
    d?.project &&
    typeof d.project === 'object' &&
    Array.isArray(d?.messages) &&
    (d.messages            ).some(
      (message) =>
        (message?.role === 'user' || message?.role === 'assistant') &&
        !!message?.content &&
        typeof message.content === 'object' &&
        typeof (message.content          ).content === 'string',
    )
  ) {
    return true;
  }
  // Some Anthropic exports wrap the conversation array in an object. The
  // builder has always supported this shape, but provider detection did not,
  // making that code path unreachable through the public parser.
  return (
    Array.isArray(d?.conversations) &&
    (d.conversations             ).some(
      (conversation) => !!conversation && Array.isArray((conversation          ).chat_messages),
    )
  );
};

const isOpenAIFormat = (data         )          => {
  if (Array.isArray(data) && data.length > 0 && (data[0]          )?.mapping != null) return true;
  return !Array.isArray(data) && (data          )?.mapping != null;
};

const isOpenRouterFormat = (data         )          => {
  const d = data          ;
  return d?.platform === 'openrouter' && Array.isArray(d?.turns);
};

// LM Studio stores one JSON file per conversation. There is no documented,
// stable schema (LM Studio's own docs say not to rely on the format), so this
// detector keys off the structural shape: a `messages` array whose entries are
// `{ versions, currentlySelected }`. Empty conversations are matched via the
// LM-Studio-specific prediction-config fields.
const isLMStudioFormat = (data         )          => {
  if (Array.isArray(data)) return false;
  const d = data          ;
  if (!Array.isArray(d?.messages)) return false;
  const messages = d.messages            ;
  if (messages.length === 0) {
    return 'usePerChatPredictionConfig' in d || 'perChatPredictionConfig' in d;
  }
  return messages.some(
    (msg) => Array.isArray((msg          )?.versions) && 'currentlySelected' in (msg          ),
  );
};

// Grok (x.ai) account export. The dump is a single `prod-grok-backend.json`
// with `{ conversations, projects, tasks, media_posts }` at the root, where each
// conversation is `{ conversation: {…meta}, responses: [{ response: {…} }] }`.
// There is no documented, stable schema, so this detector keys off that nested
// shape rather than any one field.
const isGrokFormat = (data         )          => {
  if (Array.isArray(data)) return false;
  const d = data          ;
  if (!Array.isArray(d?.conversations)) return false;
  const entries = d.conversations            ;
  if (entries.length === 0) {
    // Empty account export: fall back to the Grok-specific sibling collections.
    return 'media_posts' in d && 'tasks' in d && 'projects' in d;
  }
  const first = entries[0]          ;
  return !!first && typeof first === 'object' && 'conversation' in first && 'responses' in first;
};

// --- Core dispatch ---

const parseInput = (input         )                                    => {
  try {
    return { data: typeof input === 'string' ? JSON.parse(input) : input };
  } catch (e) {
    return { data: undefined, error: `Invalid JSON: ${(e         ).message}` };
  }
};

const flattenParseResult = (result             )                  => {
  if (result.error) return { turns: [], error: result.error };
  return { turns: result.conversations.flatMap((c) => c.turns) };
};

const parseConversations = (input         , options               = {})              => {
  const parsed = parseInput(input);
  if (parsed.error) return { conversations: [], error: parsed.error };
  const { data } = parsed;

  switch (detectProvider(data)) {
    case 'google-ai-studio':
      return buildGoogleConversation(data          , options);
    case 'grok':
      return { conversations: buildGrokConversations(data          , options) };
    case 'anthropic':
      return { conversations: buildAnthropicConversations(data, options) };
    case 'openai':
      return { conversations: buildOpenAIConversations(data, options) };
    case 'openrouter':
      return buildOpenRouterConversation(data          , options);
    case 'lm-studio':
      return buildLMStudioConversation(data          , options);
    case 'unknown':
      return {
        conversations: [],
        error:
          'Unknown export format (expected Google AI Studio, Anthropic, OpenAI, OpenRouter, LM Studio, or Grok)',
      };
  }
};

// --- Timestamp normalization ---

const normalizeTimestamp = (value         )                     => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const fromEpoch = normalizeTimestamp(asNumber);
      if (fromEpoch) return fromEpoch;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  // Reject implausible epochs: compact date strings like "20240101120000"
  // are Number()-finite but land centuries away when read as milliseconds.
  if (ms < Date.UTC(2000, 0, 1) || ms >= Date.UTC(2100, 0, 1)) return undefined;
  return new Date(ms).toISOString();
};

const getTimestamp = (...objects           )                     => {
  for (const obj of objects) {
    const o = obj                      ;
    const value =
      o?.create_time ??
      o?.created_at ??
      o?.createdAt ??
      o?.timestamp ??
      o?.time ??
      o?.date ??
      o?.update_time ??
      o?.updated_at ??
      o?.updatedAt;
    const normalized = normalizeTimestamp(value);
    if (normalized) return normalized;
  }
  return undefined;
};

const withMeta = (turn      , { createdAt }                         = {})       => {
  return createdAt ? { ...turn, createdAt } : turn;
};

// --- Title normalization ---

const summarizeConversationTitle = (turns        , fallback        )         => {
  const firstText = turns
    .map((turn) => turn.user ?? turn.ai ?? turn.thinking ?? '')
    .find((text) => typeof text === 'string' && text.trim());

  if (!firstText) return fallback;
  const normalized = firstText.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
};

const normalizeConversationTitle = (
  rawTitle         ,
  fallback        ,
  turns         = [],
)         => {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  return title || summarizeConversationTitle(turns, fallback);
};

// --- Google AI Studio ---

const buildGoogleConversation = (data        , options               = {})              => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const chunks = (data?.chunkedPrompt          )?.chunks;
  const imagenTurns = (data?.imagenPrompt          )?.imagenTurns;
  if (Array.isArray(imagenTurns)) {
    const turns         = [];
    const model =
      typeof (data?.runSettings          )?.model === 'string'
        ? ((data.runSettings          ).model          )
        : undefined;
    const defaultCreatedAt = getTimestamp(data, data?.metadata, data?.runSettings);

    for (const entry of imagenTurns) {
      const imagenTurn = entry          ;
      const createdAt = getTimestamp(imagenTurn, imagenTurn?.metadata) ?? defaultCreatedAt;
      const prompt = typeof imagenTurn?.prompt === 'string' ? imagenTurn.prompt.trim() : '';
      if (includeUser && prompt) turns.push(withMeta({ user: prompt }, { createdAt }));

      if (
        includeAi &&
        Array.isArray(imagenTurn?.generatedImages) &&
        imagenTurn.generatedImages.length > 0
      ) {
        turns.push(
          withMeta(model ? { ai: '[image]', model } : { ai: '[image]' }, {
            createdAt,
          }),
        );
      }
    }

    if (!turns.length) return { conversations: [] };
    return {
      conversations: [
        {
          key: 'google:0',
          title: normalizeConversationTitle(
            data?.title ?? data?.name ?? (data?.metadata          )?.title,
            'Conversation 1',
            turns,
          ),
          turns,
        },
      ],
    };
  }

  if (!Array.isArray(chunks)) {
    return { conversations: [], error: 'Missing or invalid chunkedPrompt.chunks' };
  }

  const turns         = [];
  const model =
    typeof (data?.runSettings          )?.model === 'string'
      ? ((data.runSettings          ).model          )
      : undefined;
  const defaultCreatedAt = getTimestamp(data, data?.metadata, data?.runSettings);

  for (const chunk of chunks) {
    const c = chunk          ;
    const role = c?.role          ;
    const createdAt = getTimestamp(c, c?.metadata) ?? defaultCreatedAt;

    if (role === 'user') {
      if (!includeUser) continue;
      const text = c.text;
      if (typeof text === 'string' && text.trim()) {
        turns.push(withMeta({ user: text.trim() }, { createdAt }));
      } else if (c.driveImage) {
        turns.push(withMeta({ user: '[image]' }, { createdAt }));
      }
      continue;
    }

    if (role === 'model') {
      const text = c.text          ;
      const isThought = c.isThought === true;
      if (isThought && includeThinking && typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed)
          turns.push(
            withMeta(model ? { thinking: trimmed, model } : { thinking: trimmed }, { createdAt }),
          );
      } else if (!isThought && includeAi && typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed)
          turns.push(withMeta(model ? { ai: trimmed, model } : { ai: trimmed }, { createdAt }));
      }
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'google:0',
        title: normalizeConversationTitle(
          data?.title ?? data?.name ?? (data?.metadata          )?.title,
          'Conversation 1',
          turns,
        ),
        turns,
      },
    ],
  };
};

// --- Anthropic ---

const extractAnthropicMessageContent = (
  msg        ,
    
                   
                          
                    
) => {
  const contentObject =
    msg?.content && !Array.isArray(msg.content) && typeof msg.content === 'object'
      ? (msg.content          )
      : undefined;
  const content = Array.isArray(msg?.content)
    ? (msg.content            )
    : Array.isArray(contentObject?.contentBlocks)
      ? (contentObject.contentBlocks            )
      : [];
  const thinkingTexts           = [];
  const aiTexts           = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') {
      const rawThinking =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : '';
      const text = rawThinking.trim();
      if (text) thinkingTexts.push(text);
      continue;
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? (block.text          ).trim() : '';
      if (text) aiTexts.push(text);
    }
  }

  const fallbackText =
    typeof msg?.text === 'string'
      ? (msg.text          ).trim()
      : typeof contentObject?.content === 'string'
        ? (contentObject.content          ).trim()
        : '';
  if (!contentObject && content.length === 0 && fallbackText) {
    aiTexts.push(fallbackText);
  }

  return {
    userText: contentObject
      ? fallbackText
      : content.length === 0
        ? fallbackText
        : aiTexts.join('\n\n') || fallbackText,
    thinkingTexts,
    aiTexts: contentObject
      ? fallbackText
        ? [fallbackText]
        : []
      : content.length === 0
        ? aiTexts
        : aiTexts.length
          ? aiTexts
          : fallbackText
            ? [fallbackText]
            : [],
  };
};

const buildAnthropicConversations = (data         , options               = {})                 => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const d = data          ;
  const isProjectConversation =
    !Array.isArray(data) &&
    !!d?.project &&
    typeof d.project === 'object' &&
    Array.isArray(d?.messages);
  const sourceConversations           = isProjectConversation
    ? [{ ...d, chat_messages: d.messages }]
    : Array.isArray(data)
      ? (data            )
      : d?.conversations
        ? (d.conversations            )
        : [d];
  const conversations                 = [];

  for (const [index, conv] of sourceConversations.entries()) {
    const messages = conv?.chat_messages;
    if (!Array.isArray(messages)) continue;

    const turns         = [];
    for (const msg of messages            ) {
      const sender = (msg?.sender ?? msg?.role)          ;
      const model =
        typeof msg?.model === 'string'
          ? (msg.model          )
          : typeof msg?.model_slug === 'string'
            ? (msg.model_slug          )
            : typeof conv?.model === 'string'
              ? (conv.model          )
              : undefined;
      const createdAt = getTimestamp(msg) ?? getTimestamp(conv);
      const extracted = extractAnthropicMessageContent(msg);

      if ((sender === 'human' || sender === 'user') && includeUser) {
        const text = extracted.userText;
        if (text) turns.push(withMeta({ user: text }, { createdAt }));
      } else if (sender === 'assistant' || sender === 'model') {
        if (includeThinking) {
          for (const thought of extracted.thinkingTexts) {
            turns.push(
              withMeta(model ? { thinking: thought, model } : { thinking: thought }, { createdAt }),
            );
          }
        }
        if (includeAi) {
          for (const text of extracted.aiTexts) {
            turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
          }
        }
      }
    }

    if (!turns.length) continue;
    const rawKey = conv?.uuid ?? conv?.id ?? conv?.conversation_id ?? index;
    conversations.push({
      key: `anthropic:${String(rawKey)}`,
      title: normalizeConversationTitle(
        conv?.name ?? conv?.title,
        `Conversation ${index + 1}`,
        turns,
      ),
      turns,
    });
  }

  return conversations;
};

// --- OpenAI / ChatGPT ---

const extractOpenAIText = (content         )         => {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return (content             )
      .map((part) => extractOpenAIText(part))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  const c = content          ;
  if (typeof c.text === 'string') return (c.text          ).trim();
  if (Array.isArray(c.parts)) {
    return (c.parts             )
      .map((part) => {
        if (typeof part === 'string') return part.trim();
        if (part && typeof (part          ).text === 'string')
          return ((part          ).text          ).trim();
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
};

const buildOpenAIPathToNode = (mapping        , nodeId        )           => {
  const chain           = [];
  let cursor                     = nodeId;
  const seen = new Set        ();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(mapping[cursor]          );
    cursor = (mapping[cursor]          )?.parent                      ;
  }
  return chain.reverse();
};

const getOpenAINodeCreateTime = (node        )         => {
  const value = (node?.message          )?.create_time;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const getOpenAIConversationPath = (conversation        )           => {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  const currentNodeId = conversation?.current_node;
  if (typeof currentNodeId === 'string' && (mapping          )[currentNodeId]) {
    return buildOpenAIPathToNode(mapping          , currentNodeId);
  }

  const nodesById = mapping          ;
  const childIds = new Set(
    (Object.values(nodesById)            )
      .map((node) => node?.parent)
      .filter((parent)                   => typeof parent === 'string'),
  );
  const timedNodes = Object.entries(nodesById)
    .filter(([, node]) => getOpenAINodeCreateTime(node          ) > 0)
    .map(([id, node]) => ({ id, node: node           }));
  if (childIds.size === 0) {
    return timedNodes
      .map(({ node }) => node)
      .sort((a, b) => getOpenAINodeCreateTime(a) - getOpenAINodeCreateTime(b));
  }
  const leafNodes = timedNodes.filter(({ id }) => !childIds.has(id));
  const candidates = leafNodes.length ? leafNodes : timedNodes;
  const latest = candidates.sort(
    (a, b) => getOpenAINodeCreateTime(b.node) - getOpenAINodeCreateTime(a.node),
  )[0];
  return latest ? buildOpenAIPathToNode(nodesById, latest.id) : [];
};

const getOpenAIModel = (message                    , conversation        )                     => {
  if (typeof (message?.metadata          )?.model_slug === 'string')
    return (message .metadata          ).model_slug          ;
  if (typeof message?.model_slug === 'string') return message.model_slug          ;
  if (typeof conversation?.default_model_slug === 'string')
    return conversation.default_model_slug          ;
  return undefined;
};

const isOpenAITechnicalArtifact = (message        , text        )          => {
  const contentType = (message?.content          )?.content_type;
  const trimmed = text.trim();
  if (trimmed === '{}' || trimmed === '<' || trimmed === '[]') return true;
  if (contentType === 'code' && /^search\(/i.test(trimmed)) return true;
  return false;
};

const buildOpenAIConversations = (data         , options               = {})                 => {
  const { includeUser = true, includeAi = true } = options;
  const sourceConversations           = Array.isArray(data) ? (data            ) : [data          ];
  const conversations                 = [];

  for (const [index, conversation] of sourceConversations.entries()) {
    const path = getOpenAIConversationPath(conversation);
    const turns         = [];

    for (const node of path) {
      const message = node?.message                      ;
      const role = (message?.author          )?.role                      ;
      const text = extractOpenAIText(message?.content);
      const model = getOpenAIModel(message, conversation);
      const createdAt = getTimestamp(message, conversation);
      if (!text) continue;
      if (role === 'assistant' && message && isOpenAITechnicalArtifact(message, text)) continue;

      if (role === 'user' && includeUser) {
        turns.push(withMeta({ user: text }, { createdAt }));
      } else if (role === 'assistant' && includeAi) {
        turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
      }
    }

    if (!turns.length) continue;
    const rawKey =
      conversation?.id ?? conversation?.conversation_id ?? conversation?.title ?? index;
    conversations.push({
      key: `openai:${String(rawKey)}`,
      title: normalizeConversationTitle(conversation?.title, `Conversation ${index + 1}`, turns),
      turns,
    });
  }

  return conversations;
};

// --- OpenRouter ---

const extractOpenRouterText = (turn        )         => {
  const value = turn?.content ?? turn?.text ?? turn?.message;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return (value             )
      .map((part) => {
        if (typeof part === 'string') return part.trim();
        if (typeof (part          )?.text === 'string')
          return ((part          ).text          ).trim();
        if (typeof (part          )?.content === 'string')
          return ((part          ).content          ).trim();
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
};

const buildOpenRouterConversation = (data        , options               = {})              => {
  const { includeUser = true, includeAi = true } = options;
  const sourceTurns = Array.isArray(data?.turns) ? (data.turns            ) : [];
  const turns         = [];

  for (const turn of sourceTurns) {
    const role = String(turn?.role || '').toLowerCase();
    const text = extractOpenRouterText(turn);
    if (!text) continue;
    const createdAt = getTimestamp(turn);

    if (role === 'user' && includeUser) {
      turns.push(withMeta({ user: text }, { createdAt }));
    } else if ((role === 'assistant' || role === 'model' || role === 'ai') && includeAi) {
      const model =
        typeof turn?.model === 'string' && (turn.model          ).trim()
          ? (turn.model          ).trim()
          : undefined;
      turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'openrouter:0',
        title: normalizeConversationTitle(data?.title ?? data?.name, 'Conversation 1', turns),
        turns,
      },
    ],
  };
};

// --- LM Studio ---

// Harmony / channel control tokens (e.g. `<|start|>assistant<|channel|>final<|message|>`)
// leak into the stored text for some local models (gpt-oss et al.). In that format the
// real content follows the last `<|message|>` marker; everything before it is role/channel
// metadata. Strip it so it does not pollute search.
const stripControlTokens = (text        )         => {
  const marker = '<|message|>';
  const lastMessage = text.lastIndexOf(marker);
  const body = lastMessage >= 0 ? text.slice(lastMessage + marker.length) : text;
  return body.replace(/<\|[^|]*\|>/g, '').trim();
};

const extractLMStudioText = (content         )         => {
  if (!Array.isArray(content)) return '';
  return (content            )
    .map((block) =>
      block && block.type === 'text' && typeof block.text === 'string'
        ? stripControlTokens(block.text          )
        : '',
    )
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildLMStudioConversation = (data        , options               = {})              => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const messages = Array.isArray(data?.messages) ? (data.messages            ) : [];
  const model =
    typeof (data?.lastUsedModel          )?.identifier === 'string'
      ? ((data.lastUsedModel          ).identifier          )
      : undefined;
  const createdAt = getTimestamp(data);
  const turns         = [];

  for (const message of messages) {
    const versions = Array.isArray(message?.versions) ? (message.versions            ) : [];
    if (!versions.length) continue;
    const selected = message?.currentlySelected;
    const index = typeof selected === 'number' && versions[selected] ? (selected          ) : 0;
    const version = versions[index];
    const role = version?.role          ;

    if (role === 'user') {
      if (!includeUser) continue;
      const text = extractLMStudioText(version?.content);
      if (text) turns.push(withMeta({ user: text }, { createdAt }));
      continue;
    }

    if (role !== 'assistant') continue;
    const senderName = (version?.senderInfo                      )?.senderName;
    const messageModel =
      typeof senderName === 'string' && senderName.trim() ? senderName.trim() : model;

    // multiStep assistant messages split reasoning ("thinking") and answer into
    // separate steps; singleStep messages carry text directly on `content`.
    const steps = Array.isArray(version?.steps) ? (version.steps            ) : null;
    if (!steps) {
      const text = extractLMStudioText(version?.content);
      if (text && includeAi) {
        turns.push(
          withMeta(messageModel ? { ai: text, model: messageModel } : { ai: text }, { createdAt }),
        );
      }
      continue;
    }

    for (const step of steps) {
      if (step?.type !== 'contentBlock') continue; // skip debugInfoBlock and friends
      const text = extractLMStudioText(step?.content);
      if (!text) continue;
      const isThought = (step?.style          )?.type === 'thinking';
      if (isThought) {
        if (includeThinking) {
          turns.push(
            withMeta(messageModel ? { thinking: text, model: messageModel } : { thinking: text }, {
              createdAt,
            }),
          );
        }
      } else if (includeAi) {
        turns.push(
          withMeta(messageModel ? { ai: text, model: messageModel } : { ai: text }, { createdAt }),
        );
      }
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'lmstudio:0',
        title: normalizeConversationTitle(data?.name, 'Conversation 1', turns),
        turns,
      },
    ],
  };
};

// --- Grok (x.ai) ---

// Grok stores timestamps as MongoDB extended JSON, e.g.
// `{ "$date": { "$numberLong": "1772641368389" } }` (sometimes `{ "$date": <ms|iso> }`).
// Unwrap to a value `normalizeTimestamp` understands.
const unwrapGrokDate = (value         )          => {
  if (value && typeof value === 'object' && '$date' in (value          )) {
    const inner = (value          ).$date;
    if (inner && typeof inner === 'object' && '$numberLong' in (inner          )) {
      return (inner          ).$numberLong;
    }
    return inner;
  }
  return value;
};

const grokTimestamp = (response        )                     =>
  normalizeTimestamp(unwrapGrokDate(response?.create_time));

// Grok keeps the model's reasoning in `agent_thinking_traces: [{ thinking_trace }]`.
const extractGrokThinking = (response        )         => {
  const traces = Array.isArray(response?.agent_thinking_traces)
    ? (response.agent_thinking_traces            )
    : [];
  return traces
    .map((trace) => (typeof trace?.thinking_trace === 'string' ? trace.thinking_trace.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildGrokConversations = (data        , options               = {})                 => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const entries = Array.isArray(data?.conversations) ? (data.conversations            ) : [];
  const conversations                 = [];

  for (const [index, entry] of entries.entries()) {
    const meta = (entry?.conversation          ) ?? {};
    const responses = Array.isArray(entry?.responses) ? (entry.responses            ) : [];
    const turns         = [];

    for (const wrapper of responses) {
      const response = (wrapper?.response          ) ?? {};
      const sender = String(response?.sender || '').toLowerCase();
      const message = typeof response?.message === 'string' ? response.message.trim() : '';
      const createdAt = grokTimestamp(response) ?? grokTimestamp(meta);

      if (sender === 'human') {
        if (includeUser && message) turns.push(withMeta({ user: message }, { createdAt }));
        continue;
      }

      // Everything else is an assistant turn (sender is "assistant"/"ASSISTANT").
      const model =
        typeof response?.model === 'string' && response.model.trim()
          ? (response.model          ).trim()
          : undefined;

      if (includeThinking) {
        const thinking = extractGrokThinking(response);
        if (thinking) {
          turns.push(withMeta(model ? { thinking, model } : { thinking }, { createdAt }));
        }
      }
      if (includeAi && message) {
        turns.push(withMeta(model ? { ai: message, model } : { ai: message }, { createdAt }));
      }
    }

    if (!turns.length) continue;
    const rawKey = meta?.id ?? meta?.conversation_id ?? index;
    conversations.push({
      key: `grok:${String(rawKey)}`,
      title: normalizeConversationTitle(meta?.title, `Conversation ${index + 1}`, turns),
      turns,
    });
  }

  return conversations;
};

export { getOpenAIConversationPath, normalizeTimestamp, getTimestamp, stripControlTokens };
