"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { transformMathDelimiters } from "@/src/core";
import { streamdownPlugins } from "./message";
import { mdComponents } from "@/components/md-blocks";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const AUTO_CLOSE_DELAY = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    children,
    ...props
  }: ReasoningProps) => {
    // COLLAPSED BY DEFAULT, ALWAYS: the old default opened on streaming and an auto-open effect re-fought a manual collapse
    const resolvedDefaultOpen = defaultOpen ?? false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);

    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen]
    );

    const contextValue = useMemo(
      () => ({ isOpen, isStreaming, setIsOpen }),
      [isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};

/* The settled label: static "Agent's thinking" — the duration was live-turn state that died on remount anyway ("thought for a few seconds") */
const defaultGetThinkingMessage = (isStreaming: boolean) => {
  if (isStreaming) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  return <p>AGENT’S THINKING</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          /* The heading register: the small mono caps of the card eyebrows — matching YOUR THINKING */
          "flex w-full items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground",
          className
        )}
        {...props}
        /* FOCUS HYGIENE: a pointer click on the thinking toggle must not leave focus here — the learner's next Enter submits, it must not re-toggle. */
        onClick={(e) => blurAfterPointerClick(e)}
      >
        {children ?? (
          <>
            {/* The working-state grammar: the Braille spinner replaces the brain icon WHILE STREAMING ONLY — motion is the signal… */}
            {isStreaming && <BrailleSpinner label="Thinking" />}
            {getThinkingMessage(isStreaming)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

// Shares message.tsx's Streamdown config (math delimiters, dark mermaid, remark-breaks) — reasoning renders the same contract as message text.

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      <Streamdown components={mdComponents} plugins={streamdownPlugins}>
        {transformMathDelimiters(children)}
      </Streamdown>
    </CollapsibleContent>
  )
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
