import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ProviderRegistry } from '../../../shared/bridge';

export interface ModelPickerProps {
  registry: ProviderRegistry | null;
  disabled: boolean;
  onSelect: (providerId: string, model: string) => void;
}

interface Selection {
  providerId: string;
  model: string;
}

const TRIGGER_CLASS =
  'no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 min-w-0';

const TRIGGER_CONTENT_CLASS = '_ModelPickerTriggerContent_13ikv_2';
const TRIGGER_MEASUREMENT_CLASS = '_ModelPickerTriggerMeasurement_13ikv_2';
const TRIGGER_LABEL_CLASS = '_ModelPickerTriggerLabel_13ikv_2';
const TRIGGER_MODEL_GROUP_CLASS = '_ModelPickerTriggerModelGroup_13ikv_2';
const TRIGGER_MODEL_LABEL_CLASS = '_ModelPickerTriggerModelLabel_13ikv_2';
const TRIGGER_MODEL_TEXT_CLASS = '_ModelPickerTriggerModelText_13ikv_2';

const DROPDOWN_CONTENT_CLASS = '_ModelPickerDropdownContent_13ikv_2';
const DROPDOWN_REDUCED_MOTION_CLASS = '_ModelPickerDropdownReducedMotion_13ikv_2';
const MENU_SURFACE_CLASS = 'no-drag z-50 m-px flex select-none flex-col bg-surface-elevated-secondary/90 text-default ring-(--color-border-overlay) ring-(length:--dropdown-overlay-ring-width) shadow-(--shadow-dropdown-overlay) backdrop-blur-sm rounded-2xl p-[var(--app-menu-gutter,var(--spacing))]';
const PICKER_MENU_CLASS = '_Menu_5d7qv_2';
const VIEW_TRACK_CLASS = '_ViewTrack_5d7qv_2';
const VIEW_PANEL_CLASS = '_ViewPanel_5d7qv_2';
const MODEL_LIST_MOTION_CLASS = '_ModelListMotion_5d7qv_2';
const MODEL_LIST_CLASS = '_ModelList_5d7qv_2';
const SECTION_LABEL_CLASS = '_sectionLabel_1is6j_2';
const ITEM_BASE_CLASS = '_itemBase_1is6j_2';
const ITEM_INTERACTIVE_CLASS = '_itemInteractive_1is6j_2';
const MENU_ROW_CONTENT_CLASS = 'flex w-full items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]';

const CHEVRON_PATH =
  'M12.1338 5.94433C12.3919 5.77382 12.7434 5.80202 12.9707 6.02929C13.1979 6.25656 13.2261 6.60807 13.0556 6.8662L12.9707 6.9707L8.47067 11.4707C8.21097 11.7304 7.78896 11.7304 7.52926 11.4707L3.02926 6.9707L2.9443 6.8662C2.77379 6.60807 2.80199 6.25656 3.02926 6.02929C3.25653 5.80202 3.60804 5.77382 3.86617 5.94433L3.97067 6.02929L7.99996 10.0586L12.0293 6.02929L12.1338 5.94433Z';

const CHECK_PATH =
  'M18.063 5.674a1 1 0 0 1 .263 1.39l-7.5 11a1 1 0 0 1-1.533.143l-4.5-4.5a1 1 0 1 1 1.414-1.414l3.647 3.647 6.82-10.003a1 1 0 0 1 1.39-.263Z';

function getDefaultSelection(registry: ProviderRegistry | null): Selection | null {
  if (registry === null || registry.providers.length === 0) {
    return null;
  }
  const activeProvider =
    registry.providers.find((provider) => provider.id === registry.activeProviderId) ?? registry.providers[0];
  if (activeProvider === undefined) {
    return null;
  }
  const hasDefaultModel = activeProvider.models.some((model) => model.id === activeProvider.defaultModel);
  const model = hasDefaultModel ? activeProvider.defaultModel : activeProvider.models[0]?.id;
  if (model === undefined) {
    return null;
  }
  return { providerId: activeProvider.id, model };
}

export default function ModelPicker({ registry, disabled, onSelect }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const selection = useMemo(() => getDefaultSelection(registry), [registry]);
  const [reduceMotion, setReduceMotion] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [side, setSide] = useState<'top' | 'bottom'>('bottom');
  const [sideOffset, setSideOffset] = useState(4);
  const [panelHeight, setPanelHeight] = useState<number>();

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(media.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setReduceMotion(event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!open || trigger === null) return;
    const requestedSide = trigger.closest('[data-dropdown-overlay-side]')?.getAttribute('data-dropdown-overlay-side');
    const placementSide = requestedSide === 'top' ? 'top' : 'bottom';
    setSide(placementSide);
    const surface = trigger.closest<HTMLElement>('[data-menu-overlay-surface]');
    const update = () => {
      const triggerBounds = trigger.getBoundingClientRect();
      const surfaceBounds = surface?.getBoundingClientRect();
      const inset = surfaceBounds === undefined ? 0 : placementSide === 'top'
        ? triggerBounds.top - surfaceBounds.top : surfaceBounds.bottom - triggerBounds.bottom;
      // Original X3/Mgn/Ngn: 5 - zoom + nonnegative surface inset; this shell uses zoom 1.
      setSideOffset(4 + Math.max(0, inset));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(trigger);
    if (surface !== null) observer.observe(surface);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || panel === null) return;
    const update = () => setPanelHeight(panel.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, panel]);

  useLayoutEffect(() => {
    if (!open || menu === null) return;
    const frame = window.requestAnimationFrame(() => {
      const checked = menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
      const first = menu.querySelector<HTMLElement>('[role="menuitemradio"]');
      (checked ?? first)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, menu]);

  const selectedProvider = useMemo(() => {
    if (registry === null || selection === null) {
      return null;
    }
    return registry.providers.find((provider) => provider.id === selection.providerId) ?? null;
  }, [registry, selection]);

  const selectedModel = useMemo(() => {
    if (selectedProvider === null || selection === null) {
      return null;
    }
    return selectedProvider.models.find((model) => model.id === selection.model) ?? null;
  }, [selectedProvider, selection]);

  const displayText =
    selectedProvider !== null && selectedModel !== null
      ? `${selectedProvider.name} \u00b7 ${selectedModel.label ?? selectedModel.id}`
      : selectedProvider !== null
        ? selectedProvider.name
        : 'Select model';

  const choose = (providerId: string, model: string) => {
    onSelect(providerId, model);
    setOpen(false);
  };

  const dropdownClassName = `${MENU_SURFACE_CLASS} ${DROPDOWN_CONTENT_CLASS} overflow-x-hidden overflow-y-hidden${reduceMotion ? ` ${DROPDOWN_REDUCED_MOTION_CLASS}` : ''}`;

  return (
    <DropdownMenu.Root modal={false} open={open && !disabled} onOpenChange={next => { if (!disabled || !next) setOpen(next); }}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
      <button
        ref={triggerRef}
        type="button"
        className={TRIGGER_CLASS}
        aria-label="Select model"
        disabled={disabled}
        data-codex-intelligence-trigger="true"
        data-composer-navigation-target="reasoning"
      >
        <span className={TRIGGER_CONTENT_CLASS}>
          <span aria-hidden="true" className={TRIGGER_MEASUREMENT_CLASS}>
            Select model
          </span>
          <span className={TRIGGER_LABEL_CLASS}>
            <span className={TRIGGER_MODEL_GROUP_CLASS}>
              <span className={TRIGGER_MODEL_LABEL_CLASS}>
                <span className={TRIGGER_MODEL_TEXT_CLASS}>{displayText}</span>
              </span>
            </span>
          </span>
        </span>
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className="text-tertiary"
          aria-hidden="true"
        >
          <path d={CHEVRON_PATH} />
        </svg>
      </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={setMenu}
          aria-label="Select model"
          className={dropdownClassName}
          side={side}
          align="center"
          sideOffset={sideOffset}
          collisionPadding={6}
          loop
          style={{
            maxWidth: 'min(var(--radix-dropdown-menu-content-available-width), calc(100vw - 16px))',
            maxHeight: 'min(var(--radix-dropdown-menu-content-available-height), calc(100vh - 16px))',
            backgroundColor: 'var(--model-picker-background, color-mix(in oklab, var(--color-surface-elevated-secondary) 90%, transparent))',
          }}
          onCloseAutoFocus={event => { if (!document.hasFocus()) event.preventDefault(); }}
        >
          {/* TODO(stub): 原应用的 zoom context、隐藏标签 end 对齐及 spring 宽度/开场时序尚未接入；保留原 CSS，不以近似动画替代。 */}
          <div
            className={PICKER_MENU_CLASS}
            data-reduced-motion={reduceMotion ? 'true' : 'false'}
            data-transitions-ready="true"
            data-model-picker-view="advanced"
            style={{ height: panelHeight === undefined ? undefined : `min(${panelHeight}px, var(--radix-dropdown-menu-content-available-height))` }}
          >
            <div className={VIEW_TRACK_CLASS} data-active="true">
              <div ref={setPanel} className={VIEW_PANEL_CLASS}>
                <div className={MODEL_LIST_MOTION_CLASS} data-active="true">
                  <div className={MODEL_LIST_CLASS}>
                    <div data-menu-section-label="true" className={SECTION_LABEL_CLASS}>
                      Select model
                    </div>
                    <DropdownMenu.RadioGroup value={selection === null ? '' : JSON.stringify([selection.providerId, selection.model])}>
                    {(registry?.providers ?? []).map((provider) => (
                      <div key={provider.id}>
                        <div data-menu-section-label="true" className={SECTION_LABEL_CLASS}>
                          {provider.name}
                        </div>
                        {provider.models.map((model) => {
                          const selected =
                            selection !== null &&
                            selection.providerId === provider.id &&
                            selection.model === model.id;
                          const showIdentifier = model.label !== undefined && model.label !== model.id;
                          return (
                            <DropdownMenu.RadioItem
                              key={`${provider.id}:${model.id}`}
                              value={JSON.stringify([provider.id, model.id])}
                              data-model-selected={selected ? 'true' : undefined}
                              className={`no-drag ${ITEM_BASE_CLASS} rounded-xl text-default group ${ITEM_INTERACTIVE_CLASS}${selected ? ' bg-primary-ghost-hover' : ''}`}
                              onSelect={() => {
                                choose(provider.id, model.id);
                              }}
                            >
                              <div data-menu-row-content="true" className={MENU_ROW_CONTENT_CLASS}>
                                <div className="flex min-w-0 flex-1 flex-col">
                                  <span className="min-w-0 truncate">{model.label ?? model.id}</span>
                                  {showIdentifier ? (
                                    <span className="min-w-0 text-xs leading-dense text-tertiary truncate">
                                      {model.id}
                                    </span>
                                  ) : null}
                                </div>
                                {selected ? (
                                  <svg
                                    width={24}
                                    height={24}
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100 icon-xs"
                                    aria-hidden="true"
                                  >
                                    <path fillRule="evenodd" clipRule="evenodd" d={CHECK_PATH} />
                                  </svg>
                                ) : null}
                              </div>
                            </DropdownMenu.RadioItem>
                          );
                        })}
                      </div>
                    ))}
                    </DropdownMenu.RadioGroup>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
