// VIH brand primitives: logo lockup and a small inline icon set (no icon dependency).
/* eslint-disable @next/next/no-img-element */
import type { SVGProps } from "react";

export function Logo({ size = 32, wordmark = true, product = "VoiceRAG" }: { size?: number; wordmark?: boolean; product?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img src="/brand/vih-icon.png" alt="VIH" width={size} height={size} className="rounded-lg" />
      {wordmark && (
        <span className="leading-none">
          <span className="font-display text-[17px] font-semibold tracking-tight text-white">ViH</span>
          <span className="font-display ml-1.5 text-[17px] font-semibold tracking-tight grad-text">{product}</span>
        </span>
      )}
    </span>
  );
}

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const Icon = {
  Mic: (p: P) => (<svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>),
  Stop: (p: P) => (<svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>),
  Hand: (p: P) => (<svg {...base(p)}><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-7a1.5 1.5 0 0 1 3 0V12M14 6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L4 15.5a1.6 1.6 0 0 1 2.5-2L8 15" /></svg>),
  Send: (p: P) => (<svg {...base(p)}><path d="M5 12h13M13 6l6 6-6 6" /></svg>),
  Plus: (p: P) => (<svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>),
  Chat: (p: P) => (<svg {...base(p)}><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" /></svg>),
  Doc: (p: P) => (<svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>),
  Chart: (p: P) => (<svg {...base(p)}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>),
  LogOut: (p: P) => (<svg {...base(p)}><path d="M15 17l5-5-5-5M20 12H9M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" /></svg>),
  Shield: (p: P) => (<svg {...base(p)}><path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3Z" /><path d="M9 12l2 2 4-4" /></svg>),
  Sliders: (p: P) => (<svg {...base(p)}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>),
  ThumbUp: (p: P) => (<svg {...base({ width: 15, height: 15, ...p })}><path d="M7 10v10H4V10h3Zm0 0 4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 16.8 20H7" /></svg>),
  ThumbDown: (p: P) => (<svg {...base({ width: 15, height: 15, ...p })}><path d="M17 14V4h3v10h-3Zm0 0-4 7a2 2 0 0 1-2-2v-4H6a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 7.2 4H17" /></svg>),
  Chevron: (p: P) => (<svg {...base({ width: 14, height: 14, ...p })}><path d="M9 6l6 6-6 6" /></svg>),
  X: (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>),
  Bolt: (p: P) => (<svg {...base({ width: 13, height: 13, ...p })}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>),
  Upload: (p: P) => (<svg {...base(p)}><path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>),
  Refresh: (p: P) => (<svg {...base({ width: 15, height: 15, ...p })}><path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" /></svg>),
  Trash: (p: P) => (<svg {...base({ width: 15, height: 15, ...p })}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>),
  Lock: (p: P) => (<svg {...base({ width: 14, height: 14, ...p })}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>),
};
