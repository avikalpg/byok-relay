import { useState, useRef, useEffect } from 'react'
import { ensureToken, storeKey, getToken, clearToken, streamChat, listKeys, deleteKey } from './relay.js'

const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
    defaultModel: 'claude-3-5-haiku-20241022',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
  },
]

export default function App() {
  const [provider, setProvider] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [keyStored, setKeyStored] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef(null)

  const selectedProvider = PROVIDERS.find((p) => p.id === provider)

  useEffect(() => {
    let cancelled = false
    async function hydrateKeyState() {
      if (!getToken()) {
        if (!cancelled) setKeyStored(false)
        return
      }
      try {
        const providers = await listKeys()
        if (!cancelled) setKeyStored(Array.isArray(providers) && providers.includes(provider))
      } catch {
        if (!cancelled) setKeyStored(false)
      }
    }
    hydrateKeyState()
    return () => {
      cancelled = true
    }
  }, [provider])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleStoreKey(e) {
    e.preventDefault()
    setError('')
    try {
      await ensureToken()
      await storeKey(provider, apiKey.trim())
      setKeyStored(true)
      setApiKey('')
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleReset() {
    try {
      const providers = await listKeys()
      if (Array.isArray(providers)) {
        await Promise.all(providers.map((p) => deleteKey(p)))
      }
    } finally {
      clearToken()
      setKeyStored(false)
      setMessages([])
      setError('')
    }
  }

  async function handleSend(e) {
    e.preventDefault()
    if (!input.trim() || streaming) return

    const userMsg = { role: 'user', content: input.trim() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setError('')

    // Add placeholder assistant message
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

    try {
      const history = [...messages, userMsg].map(({ role, content }) => ({ role, content }))
      await streamChat({
        provider,
        model: selectedProvider.defaultModel,
        messages: history,
        onChunk: (chunk) => {
          setMessages((prev) => {
            const updated = [...prev]
            updated[updated.length - 1] = {
              role: 'assistant',
              content: updated[updated.length - 1].content + chunk,
            }
            return updated
          })
        },
      })
    } catch (err) {
      setError(err.message)
      // Remove empty assistant placeholder on error
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && !last.content) {
          return prev.slice(0, -1)
        }
        return prev
      })
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>
          <a href="https://github.com/avikalpg/byok-relay" target="_blank" rel="noopener">
            byok-relay
          </a>{' '}
          × React + Vite
        </h1>
        <p className="subtitle">
          BYOK AI chat — your key stays encrypted on the relay, never in your browser code.
        </p>
      </header>

      {!keyStored ? (
        <section className="setup-card">
          <h2>Set up your API key</h2>
          <p>
            Your key is sent once to the relay, stored encrypted (AES-256-GCM), and never returned.
            Only a relay token lives in your browser.
          </p>
          <form onSubmit={handleStoreKey}>
            <div className="field-row">
              <label htmlFor="provider">Provider</label>
              <select
                id="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="apikey">API Key</label>
              <input
                id="apikey"
                type="password"
                placeholder={selectedProvider.placeholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={!apiKey.trim()}>
              Store key &amp; start chatting →
            </button>
          </form>
        </section>
      ) : (
        <section className="chat">
          <div className="chat-meta">
            <span className="badge">
              {selectedProvider.label} · {selectedProvider.defaultModel}
            </span>
            <button className="reset-btn" onClick={handleReset}>
              Reset / change key
            </button>
          </div>

          <div className="messages">
            {messages.length === 0 && (
              <p className="empty">Send a message to start chatting.</p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <span className="role">{msg.role === 'user' ? 'You' : 'AI'}</span>
                <p>{msg.content || <span className="cursor">▋</span>}</p>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && <p className="error">{error}</p>}

          <form className="input-row" onSubmit={handleSend}>
            <input
              type="text"
              placeholder="Type a message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
            />
            <button type="submit" disabled={!input.trim() || streaming}>
              {streaming ? '…' : 'Send'}
            </button>
          </form>
        </section>
      )}

      <footer>
        <a href="https://github.com/avikalpg/byok-relay" target="_blank" rel="noopener">
          ⭐ Star byok-relay on GitHub
        </a>
      </footer>
    </div>
  )
}
