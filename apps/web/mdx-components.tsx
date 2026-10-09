import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import {
  Addresses,
  ApiBase,
  CostExample,
  HoldExample,
  Limit,
  ModelList,
  UpgradeAuthority,
  WebSearchPrice,
} from "@/components/docs/Live";
import { ContactEmail, GoverningLaw, LegalEntity, SiteUrl } from "@/components/LegalValues";
import { PricingTable } from "@/components/landing/PricingTable";
import { TableWrap } from "@/components/TableWrap";
import { apiBase } from "@/lib/env";

// Docs MDX elements (content/docs). Code samples write the API host as {API_BASE}; it is filled in from config here.

const withApi = (s: string) => s.replaceAll("{API_BASE}", apiBase);

function Code({ children, ...rest }: ComponentProps<"code">) {
  return <code {...rest}>{typeof children === "string" ? withApi(children) : children}</code>;
}

function Pre({ children, ...rest }: ComponentProps<"pre">) {
  const code = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children.props : null;
  const text = typeof code?.children === "string" ? withApi(code.children).replace(/\n$/, "") : null;
  const lang = code?.className?.replace(/^language-/, "") ?? "";
  return (
    <div className="docs-code">
      <div className="docs-code-bar">
        <span>{lang}</span>
        {text && <CopyButton value={text} />}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: long lines scroll; the scroll needs keyboard access */}
      <pre tabIndex={0} {...rest}>
        {children}
      </pre>
    </div>
  );
}

function A({ href = "", children, ...rest }: ComponentProps<"a">) {
  if (href.startsWith("/") || href.startsWith("#"))
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

function heading(Tag: "h2" | "h3") {
  return function Heading({ id, children }: ComponentProps<"h2">) {
    return (
      <Tag id={id}>
        <a href={`#${id}`} className="docs-anchor">
          {children}
        </a>
      </Tag>
    );
  };
}

const components: MDXComponents = {
  code: Code,
  pre: Pre,
  a: A,
  h2: heading("h2"),
  h3: heading("h3"),
  table: (props) => (
    <TableWrap label="Table">
      <table {...props} />
    </TableWrap>
  ),
  Addresses,
  ApiBase,
  ContactEmail,
  GoverningLaw,
  LegalEntity,
  SiteUrl,
  CostExample,
  HoldExample,
  Limit,
  ModelList,
  PricingTable,
  UpgradeAuthority,
  WebSearchPrice,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
