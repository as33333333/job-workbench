import React from 'react'

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={'modal' + (wide ? ' wide' : '')}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function ScoreRing({ score }) {
  const v = Math.max(0, Math.min(100, Math.round(score || 0)))
  const R = 26, C = 2 * Math.PI * R
  const color = v >= 75 ? '#12b76a' : v >= 50 ? '#f79009' : '#d92d20'
  return (
    <div className="score-ring">
      <svg width="64" height="64">
        <circle cx="32" cy="32" r={R} fill="none" stroke="#eef1f6" strokeWidth="6" />
        <circle cx="32" cy="32" r={R} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={`${(v / 100) * C} ${C}`} strokeLinecap="round" />
      </svg>
      <div className="val" style={{ color }}>{v}</div>
    </div>
  )
}

export function Empty({ icon = '📭', title, children }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  )
}

export function Spinner() { return <span className="spin" /> }

export function scoreColor(v) {
  return v >= 75 ? 'green' : v >= 50 ? 'orange' : 'red'
}
