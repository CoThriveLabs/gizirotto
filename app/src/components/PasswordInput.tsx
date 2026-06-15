'use client'

import { forwardRef, useId, useState } from 'react'

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className = '', id, ...rest }, ref) {
    const [visible, setVisible] = useState(false)
    const reactId = useId()
    const inputId = id ?? reactId

    return (
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={`w-full border border-gray-300 rounded px-3 py-2 pr-10 text-base ${className}`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'パスワードを非表示' : 'パスワードを表示'}
          aria-pressed={visible}
          aria-controls={inputId}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gizirotto-blue-700"
        >
          {visible ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.6 19.6 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.7 19.7 0 0 1-3.22 4.31" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    )
  },
)
