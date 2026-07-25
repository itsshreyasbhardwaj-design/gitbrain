/**
 * GitBrain UI primitives.
 *
 * Import from `@/components/ui`. Every primitive is styled from the tokens in
 * `src/app/globals.css` — none of them hard-code a colour.
 */

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
export type {
  AccordionContentProps,
  AccordionItemProps,
  AccordionProps,
  AccordionTriggerProps,
} from './accordion';

export { Badge, badgeVariants } from './badge';
export type { BadgeProps } from './badge';

export { Button, buttonVariants } from './button';
export type { ButtonProps } from './button';

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

export { CopyButton } from './copy-button';
export type { CopyButtonProps } from './copy-button';

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './dialog';
export type {
  DialogContentProps,
  DialogDescriptionProps,
  DialogOverlayProps,
  DialogProps,
  DialogTitleProps,
} from './dialog';

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';
export type {
  DropdownMenuCheckboxItemProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuLabelProps,
  DropdownMenuProps,
  DropdownMenuRadioItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuSubContentProps,
  DropdownMenuSubTriggerProps,
} from './dropdown-menu';

export { EmptyState } from './empty-state';
export type { EmptyStateProps } from './empty-state';

export { Input } from './input';
export type { InputProps } from './input';

export { Progress } from './progress';
export type { ProgressProps, ProgressTone } from './progress';

export { ScrollArea, ScrollBar } from './scroll-area';
export type { ScrollAreaProps, ScrollBarProps } from './scroll-area';

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';
export type {
  SelectContentProps,
  SelectItemProps,
  SelectLabelProps,
  SelectProps,
  SelectSeparatorProps,
  SelectTriggerProps,
} from './select';

export { Separator } from './separator';
export type { SeparatorProps } from './separator';

export { Skeleton } from './skeleton';
export type { SkeletonProps } from './skeleton';

export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
export type { TabsContentProps, TabsListProps, TabsProps, TabsTriggerProps } from './tabs';

export { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger } from './tooltip';
export type { TooltipContentProps, TooltipProps, TooltipProviderProps } from './tooltip';
