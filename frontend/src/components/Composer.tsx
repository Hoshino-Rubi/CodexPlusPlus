import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type * as React from 'react';

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  children?: React.ReactNode;
}

const COMPOSER_BUTTON_BASE =
  'cursor-interaction size-token-button-composer flex shrink-0 items-center justify-center rounded-full transition-opacity focus-visible:outline-2';
const COMPOSER_BUTTON_DEFAULT =
  'bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary';
const COMPOSER_ICON_CLASS = 'icon-primary-action text-composer-primary';

function SendIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={COMPOSER_ICON_CLASS}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M9.33467 16.6663V4.93978L4.6374 9.63704L4.1667 9.16634L3.69599 8.69661L9.52998 2.86263L9.63447 2.77767C9.8925 2.60753 10.2433 2.63564 10.4704 2.86263L16.3034 8.69661L16.3884 8.80111C16.5588 9.05922 16.5306 9.40982 16.3034 9.63704C16.0762 9.86414 15.7255 9.89242 15.4675 9.722L15.363 9.63704L10.6647 4.9388V16.6663C10.6647 17.0336 10.367 17.3314 9.99971 17.3314C9.63259 17.3312 9.33467 17.0335 9.33467 16.6663ZM4.6374 9.63704C4.3777 9.89674 3.95569 9.89674 3.69599 9.63704C3.43657 9.37744 3.43668 8.95628 3.69599 8.69661L4.6374 9.63704Z"
        fill="currentColor"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={COMPOSER_ICON_CLASS}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z" />
    </svg>
  );
}

export default function Composer({
  busy,
  disabled,
  onSend,
  onStop,
  children,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }, [text]);

  const submit = () => {
    if (busy || disabled || text.trim().length === 0) {
      return;
    }
    onSend(text);
    setText('');
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      composingRef.current ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const sendBlocked = disabled || text.trim().length === 0;
  const buttonDisabled = busy ? false : sendBlocked;
  const buttonClassName = [
    COMPOSER_BUTTON_BASE,
    COMPOSER_BUTTON_DEFAULT,
    buttonDisabled ? 'cursor-default' : '',
    buttonDisabled ? 'opacity-50' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="composer-wrap" data-has-composer-surface="">
      <div data-role="composer">
        <div
          className="_ComposerLayoutRoot_1q7o3_2"
          data-composer-layout="multiline"
          data-composer-padding-variant="none"
          data-composer-radius-variant="default"
          data-composer-density="default"
          data-composer-surface-overflow="auto"
          data-composer-surface-variant="default"
          data-composer-utility-bar-variant="default"
          role="presentation"
        >
          <div
            className="_ComposerLayoutBody_1q7o3_2"
            data-composer-layout="multiline"
            data-composer-body=""
          >
            <div
              className="_ComposerLayoutFooter_1q7o3_2"
              data-composer-layout="multiline"
              data-composer-rows="stacked"
              data-composer-spacing="default"
              data-composer-footer-responsive=""
            >
              <div
                className="min-w-0 _AdaptiveFooterInput_1q7o3_2"
                data-composer-layout="multiline"
              >
                <div
                  className="_ComposerLayoutInput_1q7o3_2 relative flex-grow overflow-y-auto"
                  data-composer-layout="multiline"
                  data-composer-spacing="default"
                  data-composer-input-variant="default"
                  data-composer-input=""
                >
                  <div className="text-base transition-[min-height] duration-relaxed ease-enter-snappy motion-reduce:transition-none min-h-0">
                    <textarea
                      ref={textareaRef}
                      className="block w-full resize-none bg-transparent text-default outline-none placeholder:text-secondary"
                      aria-label="Message"
                      placeholder="Send a message"
                      rows={1}
                      value={text}
                      disabled={disabled || busy}
                      onChange={handleChange}
                      onKeyDown={handleKeyDown}
                      onCompositionStart={() => {
                        composingRef.current = true;
                      }}
                      onCompositionEnd={() => {
                        composingRef.current = false;
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center justify-end w-full">
                  {children != null ? (
                    <div className="flex min-w-0 flex-1 justify-end">
                      <div className="flex min-w-0 items-center">{children}</div>
                    </div>
                  ) : null}
                  <div className="flex shrink-0 items-center">
                    <div className="ms-2 flex items-center">
                      <button
                        type="button"
                        className={buttonClassName}
                        aria-disabled={buttonDisabled || undefined}
                        aria-busy={busy || undefined}
                        aria-label={busy ? 'Stop' : 'Send'}
                        disabled={buttonDisabled}
                        onClick={busy ? onStop : submit}
                      >
                        {busy ? <StopIcon /> : <SendIcon />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
