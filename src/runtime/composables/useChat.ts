// composables/useChat.ts
import { ref, computed } from 'vue'
import type {
  ChatRequest,
  ChatRequestOptions,
  CreateMessage,
  JSONValue,
  Message,
  UIMessage,
  UseChatOptions,
} from '@ai-sdk/ui-utils'
import {
  callChatApi,
  fillMessageParts,
  generateId as defaultGenerateId,
  getMessageParts,
  isAssistantMessageWithCompletedToolCalls,
  prepareAttachmentsForRequest,
  shouldResubmitMessages,
  updateToolCallResult,
} from '@ai-sdk/ui-utils'

export const useChat = (options: UseChatOptions = {}) => {
  const {
    api = '/api/chat',
    id,
    initialMessages = [],
    initialInput = '',
    sendExtraMessageFields,
    onToolCall,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    experimental_prepareRequestBody,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    maxSteps = 1,
    streamProtocol = 'data',
    onResponse,
    onFinish,
    onError,
    credentials,
    headers,
    body,
    generateId = defaultGenerateId,
    fetch,
  } = options

  const chatId = id || generateId()
  const messages = ref<UIMessage[]>(fillMessageParts(initialMessages))
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const data = ref<JSONValue[] | undefined>(undefined)
  const input = ref(initialInput)
  const status = ref<'submitted' | 'streaming' | 'ready' | 'error'>('ready')
  const error = ref<Error | undefined>(undefined)
  const abortController = ref<AbortController | null>(null)

  const isLoading = computed(() => ['submitted', 'streaming'].includes(status.value))

  const triggerRequest = async (chatRequest: ChatRequest) => {
    status.value = 'submitted'
    error.value = undefined

    const filledMessages = fillMessageParts(chatRequest.messages)
    const previousMessages = [...messages.value]

    messages.value = filledMessages

    const constructedPayload = sendExtraMessageFields
      ? filledMessages
      : filledMessages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.experimental_attachments && { experimental_attachments: m.experimental_attachments }),
          ...(m.data && { data: m.data }),
          ...(m.annotations && { annotations: m.annotations }),
          ...(m.parts && { parts: m.parts }),
        }))

    abortController.value = new AbortController()

    try {
      await callChatApi({
        api,
        body: experimental_prepareRequestBody?.({
          id: chatId,
          messages: filledMessages,
          requestData: chatRequest.data,
          requestBody: chatRequest.body,
        }) ?? {
          id: chatId,
          messages: constructedPayload,
          data: chatRequest.data,
          ...body,
          ...chatRequest.body,
        },
        streamProtocol,
        credentials,
        headers: {
          ...headers,
          ...chatRequest.headers,
        },
        abortController: () => abortController.value,
        restoreMessagesOnFailure: () => {
          messages.value = previousMessages
        },
        onResponse,
        onUpdate({ message, data: updateData, replaceLastMessage }) {
          status.value = 'streaming'
          messages.value = [
            ...(replaceLastMessage ? filledMessages.slice(0, -1) : filledMessages),
            message,
          ]
          if (updateData?.length) {
            data.value = [...(data.value ?? []), ...updateData]
          }
        },
        onToolCall,
        onFinish,
        generateId,
        fetch,
        lastMessage: filledMessages[filledMessages.length - 1],
      })

      status.value = 'ready'
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    catch (err: never) {
      if (err?.name === 'AbortError') {
        status.value = 'ready'
        return
      }

      status.value = 'error'
      error.value = err
      onError?.(err)
    }

    if (
      shouldResubmitMessages({
        originalMaxToolInvocationStep: filledMessages[filledMessages.length - 1]?.parts?.length,
        originalMessageCount: filledMessages.length,
        maxSteps,
        messages: messages.value,
      })
    ) {
      await triggerRequest({ messages: messages.value })
    }
  }

  const append = async (message: Message | CreateMessage, opts: ChatRequestOptions = {}) => {
    const attachments = await prepareAttachmentsForRequest(opts.experimental_attachments)
    const newMessage: UIMessage = {
      ...message,
      id: message.id ?? generateId(),
      createdAt: message.createdAt ?? new Date(),
      experimental_attachments: attachments.length ? attachments : undefined,
      parts: getMessageParts(message),
    }
    const updated = [...messages.value, newMessage]
    return triggerRequest({
      messages: updated,
      headers: opts.headers,
      body: opts.body,
      data: opts.data,
    })
  }

  const reload = async (opts: ChatRequestOptions = {}) => {
    const all = messages.value
    if (!all.length) return null

    const last = all[all.length - 1]
    const msgs = last.role === 'assistant' ? all.slice(0, -1) : all
    return triggerRequest({ messages: msgs, headers: opts.headers, body: opts.body, data: opts.data })
  }

  const stop = () => {
    abortController.value?.abort()
    abortController.value = null
  }

  const setMessages = (input: Message[] | ((prev: Message[]) => Message[])) => {
    const result = typeof input === 'function' ? input(messages.value) : input
    messages.value = fillMessageParts(result)
  }

  const setData = (d: JSONValue[] | undefined | ((prev?: JSONValue[]) => JSONValue[] | undefined)) => {
    data.value = typeof d === 'function' ? d(data.value) : d
  }

  const handleSubmit = async (event?: Event, opts: ChatRequestOptions = {}) => {
    event?.preventDefault?.()
    if (!input.value && !opts.allowEmptySubmit) return

    const attachments = await prepareAttachmentsForRequest(opts.experimental_attachments)

    const message: UIMessage = {
      id: generateId(),
      createdAt: new Date(),
      role: 'user',
      content: input.value,
      experimental_attachments: attachments.length ? attachments : undefined,
      parts: [{ type: 'text', text: input.value }],
    }

    input.value = ''
    await triggerRequest({
      messages: [...messages.value, message],
      headers: opts.headers,
      body: opts.body,
      data: opts.data,
    })
  }

  const addToolResult = ({ toolCallId, result }: { toolCallId: string, result: unknown }) => {
    updateToolCallResult({ messages: messages.value, toolCallId, toolResult: result })
    messages.value = [...messages.value.slice(0, -1), { ...messages.value[messages.value.length - 1] }]

    if (status.value === 'submitted' || status.value === 'streaming') return

    const last = messages.value[messages.value.length - 1]
    if (isAssistantMessageWithCompletedToolCalls(last)) {
      triggerRequest({ messages: messages.value }).catch(console.error)
    }
  }

  return {
    id: chatId,
    messages,
    data,
    input,
    error,
    isLoading,
    status,
    setInput: (v: string) => (input.value = v),
    append,
    reload,
    stop,
    setMessages,
    setData,
    handleSubmit,
    addToolResult,
  }
}
