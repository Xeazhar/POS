import { Component } from 'react'
import { hardReload } from '../../utils/hardReload'
import { isChunkLoadError, clearChunkReloadFlag } from '../../utils/lazyWithRetry'
import { PrimaryButton, SecondaryButton } from '../ui'

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[AppErrorBoundary]', error, info?.componentStack)
  }

  handleReload = () => {
    clearChunkReloadFlag()
    void hardReload({ online: typeof navigator !== 'undefined' ? navigator.onLine : true })
  }

  handleRetry = () => {
    this.setState({ error: null })
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const chunk = isChunkLoadError(error)
    const offline = chunk && typeof navigator !== 'undefined' && !navigator.onLine
    return (
      <div className="grid min-h-screen place-items-center bg-brand-canvas px-6 py-10">
        <div className="w-full max-w-md rounded-lg border border-brand-softline bg-brand-card p-6 shadow-sm">
          <p className="m-0 text-[10px] font-bold tracking-[1px] text-brand-subtle uppercase">
            CalePOS
          </p>
          <h1 className="m-0 mt-2 text-lg text-brand-ink">
            {offline ? "Can't open this page offline" : chunk ? 'App update needed' : 'Something went wrong'}
          </h1>
          <p className="m-0 mt-2 text-sm text-brand-muted">
            {offline
              ? "This page hasn't been opened on this device before, so nothing was saved for offline use. Connect once, open it, and it works offline after that."
              : chunk
                ? 'This screen loaded an older version of the app. Reload to fetch the latest build.'
                : 'The page hit an unexpected error. Your queued sales stay on this device, try reloading.'}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={this.handleRetry}>
              Try again
            </PrimaryButton>
            {/* Reloading can't fetch a chunk that was never cached without a network round
                trip — offer it only when there's a real chance it helps. */}
            {!offline && (
              <SecondaryButton type="button" onClick={this.handleReload}>
                Reload app
              </SecondaryButton>
            )}
          </div>
        </div>
      </div>
    )
  }
}
