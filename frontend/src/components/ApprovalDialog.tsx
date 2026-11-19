import type { ApprovalRequest } from '../types';

export interface ApprovalDialogProps {
  request: ApprovalRequest | null;
  onRespond: (id: string | number, approved: boolean) => void;
}

type JsonObject = Record<string, unknown>;
type ApprovalIconKind = 'terminal' | 'hand' | 'edit';

interface ApprovalView {
  icon: ApprovalIconKind;
  headerLabel: string;
  title: string;
  subtitle: string | null;
  body: string | null;
}

const EXECUTABLE_COMMAND = /^(?:.*[/\\])?(?:bash|cmd(?:\.exe)?|fish|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|zsh)(?:\s|$)/i;

const CARD_CLASS =
  '@container/approval-card flex flex-col overflow-hidden text-default focus:outline-none rounded-3xl border border-default bg-surface-elevated-secondary';

const DENY_BUTTON_CLASS =
  'no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 flex whitespace-nowrap border gap-1 rounded-full border-default bg-primary-soft-alpha not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) @max-md/approval-card:justify-center';

const ALLOW_BUTTON_CLASS =
  'no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 flex whitespace-nowrap border gap-1 rounded-full border-default bg-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80 text-primary-solid h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) min-w-0 max-w-full @max-md/approval-card:justify-center';

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function approvalReason(params: JsonObject): string | null {
  return trimmedString(params.approvalReason) ?? trimmedString(params.reason);
}

function commandFromActions(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const action = asObject(value[index]);
    const command = action === null ? null : trimmedString(action.command);
    if (command !== null && !EXECUTABLE_COMMAND.test(command)) {
      return command;
    }
  }
  return null;
}

function commandText(params: JsonObject, legacy: boolean): string {
  if (legacy) {
    const parts = Array.isArray(params.command)
      ? params.command.filter((part): part is string => typeof part === 'string')
      : [];
    return parts.join(' ').trim();
  }
  const fromActions = commandFromActions(params.commandActions);
  if (fromActions !== null) {
    return fromActions;
  }
  const command = trimmedString(params.command);
  if (command === null || EXECUTABLE_COMMAND.test(command)) {
    return '';
  }
  return command;
}

function networkDetails(params: JsonObject): { destination: string; host: string } | null {
  const context = asObject(params.networkApprovalContext);
  if (context === null) {
    return null;
  }
  const host = trimmedString(context.host);
  if (host === null) {
    return null;
  }
  const protocol = trimmedString(context.protocol);
  const destination = protocol === 'http' || protocol === 'https' ? `${protocol}://${host}` : host;
  return { destination, host };
}

function patchDetail(change: JsonObject): string | null {
  if (change.type === 'add' && typeof change.content === 'string') {
    return change.content;
  }
  if (change.type === 'delete' && typeof change.content === 'string') {
    return change.content;
  }
  if (change.type === 'update' && typeof change.unified_diff === 'string') {
    return change.unified_diff;
  }
  return null;
}

function patchPreview(params: JsonObject): string {
  const changes = asObject(params.fileChanges);
  if (changes === null) {
    return '';
  }
  const blocks: string[] = [];
  for (const [path, value] of Object.entries(changes)) {
    const change = asObject(value);
    const detail = change === null ? null : patchDetail(change);
    blocks.push(detail === null || detail.length === 0 ? path : `${path}\n${detail}`);
  }
  return blocks.join('\n\n');
}

function fallbackBody(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized === 'string') {
      return serialized;
    }
  } catch {
    return String(value);
  }
  return String(value);
}

function approvalView(request: ApprovalRequest): ApprovalView {
  const params = asObject(request.params) ?? {};
  const reason = approvalReason(params);
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const legacy = request.method === 'execCommandApproval';
      const command = commandText(params, legacy);
      if (!legacy) {
        const network = networkDetails(params);
        if (network !== null) {
          return {
            icon: 'hand',
            headerLabel: 'Internet access',
            title: `Allow ChatGPT to connect to ${network.destination}?`,
            subtitle: `${network.host} isn't on the current network allowlist`,
            body: null,
          };
        }
      }
      return {
        icon: command.length > 0 ? 'terminal' : 'hand',
        headerLabel: command.length > 0 ? 'Terminal' : 'Ask permission',
        title: reason ?? 'Allow ChatGPT to run this command?',
        subtitle: null,
        body: command.length > 0 ? command : null,
      };
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      // TODO(stub): v2 文件编辑审批的变更文件与 diff 属于线程 item，不在 ApprovalRequest.params 中，固定接口无法取得。
      const changes = asObject(params.fileChanges);
      const count = changes === null ? 0 : Object.keys(changes).length;
      const title =
        count === 1
          ? 'Allow ChatGPT to edit the following file?'
          : 'Allow ChatGPT to edit the following files?';
      const grantRoot = trimmedString(params.grantRoot);
      const preview = request.method === 'applyPatchApproval' ? patchPreview(params) : '';
      return {
        icon: 'edit',
        headerLabel: 'Edit files',
        title,
        subtitle: reason ?? grantRoot,
        body: preview.length > 0 ? preview : null,
      };
    }
    default:
      return {
        icon: 'hand',
        headerLabel: 'Ask permission',
        title: request.method,
        subtitle: null,
        body: fallbackBody(request.params),
      };
  }
}

function HandIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="icon-sm text-secondary"
      aria-hidden="true"
    >
      <path
        d="M12.6683 4.16699C12.6683 3.84391 12.4065 3.58203 12.0834 3.58203C11.7603 3.58203 11.4984 3.84391 11.4984 4.16699V7.91699L11.4847 8.05078C11.4227 8.35375 11.1547 8.58203 10.8334 8.58203C10.4662 8.58203 10.1685 8.28411 10.1683 7.91699V3.75C10.1683 3.42691 9.90646 3.16504 9.58337 3.16504C9.26029 3.16504 8.99841 3.42691 8.99841 3.75V7.91699C8.99824 8.28411 8.70053 8.58203 8.33337 8.58203C7.96621 8.58203 7.66851 8.28411 7.66833 7.91699V5C7.66833 4.67691 7.40646 4.41504 7.08337 4.41504C6.76029 4.41504 6.49841 4.67691 6.49841 5V9.30371C6.53326 9.3429 6.56715 9.38359 6.59998 9.42578L8.02478 11.2588C8.25005 11.5486 8.19821 11.9659 7.90857 12.1914C7.6187 12.4169 7.20048 12.365 6.97498 12.0752L5.55017 10.2432C5.15812 9.7391 4.41813 9.73637 4.01501 10.1924C4.04396 10.426 4.11486 10.8323 4.25525 11.3486C4.44664 12.0525 4.75404 12.9113 5.21619 13.7383C6.14103 15.3931 7.62465 16.835 10.0004 16.835C12.8545 16.8348 15.1682 14.5211 15.1683 11.667V6.25C15.1683 5.92691 14.9065 5.66504 14.5834 5.66504C14.2603 5.66504 13.9984 5.92691 13.9984 6.25V9.16699C13.9982 9.53411 13.7005 9.83203 13.3334 9.83203C12.9662 9.83203 12.6685 9.53411 12.6683 9.16699V4.16699ZM13.9984 4.42578C14.1828 4.36671 14.3794 4.33496 14.5834 4.33496C15.641 4.33496 16.4984 5.19237 16.4984 6.25V11.667C16.4982 15.2557 13.589 18.1649 10.0004 18.165C6.95953 18.165 5.10939 16.2734 4.05505 14.3867C3.52774 13.4431 3.1843 12.4787 2.97205 11.6982C2.76447 10.9349 2.66834 10.2954 2.66833 10C2.66833 9.87959 2.70117 9.76148 2.76306 9.6582C3.28988 8.78018 4.26555 8.40372 5.16833 8.56152V5C5.16833 3.94237 6.02575 3.08496 7.08337 3.08496C7.31706 3.08496 7.54039 3.12845 7.74744 3.20508C7.98218 2.41297 8.7151 1.83496 9.58337 1.83496C10.1836 1.83496 10.7186 2.11176 11.0697 2.54395C11.3639 2.35978 11.7107 2.25195 12.0834 2.25195C13.141 2.25195 13.9984 3.10937 13.9984 4.16699V4.42578Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="icon-sm text-secondary"
      aria-hidden="true"
    >
      <path
        d="M6.19629 7.86231C6.42357 7.63534 6.7752 7.60692 7.0332 7.77734L7.1377 7.86231L8.80371 9.5293C9.06329 9.78889 9.06307 10.21 8.80371 10.4697L7.1377 12.1367C6.878 12.3964 6.45599 12.3964 6.19629 12.1367C5.93686 11.8771 5.93697 11.456 6.19629 11.1963L7.39258 9.99902L6.19629 8.80371L6.11133 8.69922C5.94087 8.4411 5.96904 8.08955 6.19629 7.86231Z"
        fill="currentColor"
      />
      <path
        d="M13.4668 11.0156C13.7699 11.0776 13.998 11.3456 13.998 11.667C13.9979 11.9883 13.7698 12.2564 13.4668 12.3184L13.333 12.332H10.833C10.466 12.3319 10.1682 12.034 10.168 11.667C10.168 11.2998 10.4659 11.0021 10.833 11.002H13.333L13.4668 11.0156Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.6602 2.66504C13.3492 2.66504 13.9062 2.66439 14.3564 2.70117C14.8142 2.73859 15.2201 2.81796 15.5967 3.00977C16.1922 3.31321 16.677 3.79805 16.9805 4.39356C17.1722 4.77014 17.2517 5.17604 17.2891 5.63379C17.3258 6.08402 17.3252 6.64102 17.3252 7.33008V12.6602C17.3252 13.3492 17.3258 13.9062 17.2891 14.3564C17.2516 14.8142 17.1723 15.2201 16.9805 15.5967C16.677 16.1922 16.1922 16.677 15.5967 16.9805C15.2201 17.1723 14.8142 17.2516 14.3564 17.2891C13.9062 17.3258 13.3492 17.3252 12.6602 17.3252H7.33008C6.64102 17.3252 6.08402 17.3258 5.63379 17.2891C5.17604 17.2517 4.77014 17.1722 4.39356 16.9805C3.79805 16.677 3.31321 16.1922 3.00977 15.5967C2.81796 15.2201 2.73859 14.8142 2.70117 14.3564C2.66439 13.9062 2.66504 13.3492 2.66504 12.6602V7.33008C2.66504 6.64101 2.66439 6.08402 2.70117 5.63379C2.73858 5.17601 2.81797 4.77016 3.00977 4.39356C3.31321 3.79802 3.79802 3.31321 4.39356 3.00977C4.77016 2.81797 5.17601 2.73858 5.63379 2.70117C6.08402 2.66439 6.64101 2.66504 7.33008 2.66504H12.6602ZM7.33008 3.99512C6.61907 3.99512 6.1257 3.99601 5.74219 4.02734C5.3665 4.05804 5.15508 4.11481 4.99707 4.19531C4.65183 4.37124 4.37124 4.65183 4.19531 4.99707C4.11481 5.15508 4.05805 5.3665 4.02734 5.74219C3.99601 6.1257 3.99512 6.61908 3.99512 7.33008V12.6602C3.99512 13.3711 3.99601 13.8646 4.02734 14.248C4.05805 14.6237 4.11481 14.8352 4.19531 14.9932C4.37124 15.3384 4.65186 15.619 4.99707 15.7949C5.15507 15.8754 5.36654 15.9322 5.74219 15.9629C6.1257 15.9942 6.61908 15.9951 7.33008 15.9951H12.6602C13.3711 15.9951 13.8646 15.9942 14.248 15.9629C14.6237 15.9322 14.8352 15.8754 14.9932 15.7949C15.3384 15.619 15.619 15.3384 15.7949 14.9932C15.8754 14.8352 15.9322 14.6237 15.9629 14.248C15.9942 13.8646 15.9951 13.3711 15.9951 12.6602V7.33008C15.9951 6.61908 15.9942 6.1257 15.9629 5.74219C15.9322 5.36654 15.8754 5.15507 15.7949 4.99707C15.619 4.65186 15.3384 4.37124 14.9932 4.19531C14.8352 4.11481 14.6237 4.05805 14.248 4.02734C13.8646 3.99601 13.3711 3.99512 12.6602 3.99512H7.33008Z"
        fill="currentColor"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="icon-sm text-secondary"
      aria-hidden="true"
    >
      <path
        d="M11.7313 4.20472C13.1489 2.92391 15.3377 2.96644 16.7039 4.33265L16.8318 4.46742C18.0713 5.8393 18.0713 7.93343 16.8318 9.30531L16.7039 9.44007L10.4119 15.7311C10.0884 16.0546 9.85387 16.2917 9.62188 16.4821L9.3875 16.6588C9.18236 16.799 8.96432 16.9196 8.73711 17.0192L8.50762 17.1119C8.32585 17.1785 8.13845 17.2266 7.92168 17.2711L7.15703 17.4069L4.76348 17.8053C4.62062 17.8291 4.46916 17.8552 4.34063 17.8649C4.24185 17.8723 4.10835 17.875 3.9627 17.8395L3.81426 17.7907C3.59124 17.695 3.40749 17.5271 3.2918 17.316L3.2459 17.2223C3.1596 17.0209 3.16176 16.8276 3.17168 16.6959C3.18138 16.5674 3.20744 16.4159 3.23125 16.2731L3.62969 13.8795L3.76445 13.1149C3.80902 12.898 3.85797 12.7108 3.92461 12.5289L4.01738 12.2985C4.11693 12.0715 4.23774 11.854 4.37774 11.6491L4.55352 11.4147C4.74395 11.1825 4.98173 10.9484 5.30547 10.6246L11.5965 4.33265L11.7313 4.20472ZM6.2459 11.5651C5.89673 11.9142 5.71261 12.0998 5.58672 12.2526L5.47539 12.3991C5.38197 12.5358 5.30159 12.6812 5.23516 12.8327L5.17363 12.9869C5.1333 13.0971 5.1025 13.2125 5.06817 13.3815L4.94121 14.0983L4.54277 16.4918L4.5418 16.4938H4.54473L6.93828 16.0944L7.65508 15.9684C7.82408 15.9341 7.93949 15.9033 8.04961 15.8629L8.20293 15.8014C8.35464 15.7349 8.49956 15.6538 8.63652 15.5602L8.78399 15.4498C8.93677 15.3239 9.12233 15.1398 9.47149 14.7907L14.4588 9.80238L11.2332 6.57679L6.2459 11.5651ZM15.7635 5.27308C14.9282 4.43776 13.6058 4.38573 12.7098 5.11683L12.5369 5.27308L12.1736 5.63636L15.4002 8.86195L15.7635 8.49964L15.9197 8.32581C16.6016 7.48961 16.6016 6.28311 15.9197 5.44691L15.7635 5.27308Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ApprovalIcon({ kind }: { kind: ApprovalIconKind }) {
  if (kind === 'terminal') {
    return <TerminalIcon />;
  }
  if (kind === 'edit') {
    return <EditIcon />;
  }
  return <HandIcon />;
}

export default function ApprovalDialog({ request, onRespond }: ApprovalDialogProps) {
  if (request === null) {
    return null;
  }
  const view = approvalView(request);
  return (
    <div className={CARD_CLASS} data-codex-approval-surface="true">
      <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1" aria-atomic="true" role="alert">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2 font-normal text-secondary text-size-chat-sm leading-5">
                <ApprovalIcon kind={view.icon} />
                <span>{view.headerLabel}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="min-w-0 wrap-anywhere leading-5 font-medium text-default text-size-chat">
                  {view.title}
                </div>
                {view.subtitle === null ? null : (
                  <div className="text-size-chat-sm text-codex-description">{view.subtitle}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {view.body === null ? null : (
        <div className="px-3">
          <div className="flex max-h-80 w-full flex-col overflow-hidden rounded-md bg-surface-tertiary text-size-code text-tertiary">
            {/* TODO(stub): 原审批卡的三行折叠/展开依赖内部文本测量 Hook，静态 bundle 无法恢复该 Hook；此处保留原始预览容器并按展开态渲染完整内容。 */}
            <div className="min-h-0 overflow-y-auto px-2 pt-2 pb-2 font-mono font-medium">
              <span className="block break-words whitespace-pre-wrap">{view.body}</span>
            </div>
          </div>
        </div>
      )}
      <form
        className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-4 @max-md/approval-card:flex-col @max-md/approval-card:items-stretch"
        onSubmit={(event) => {
          event.preventDefault();
          onRespond(request.id, true);
        }}
      >
        <div className="ms-auto flex min-w-0 items-center gap-2 @max-md/approval-card:ms-0 @max-md/approval-card:w-full @max-md/approval-card:flex-col @max-md/approval-card:items-stretch">
          <button type="button" className={DENY_BUTTON_CLASS} onClick={() => onRespond(request.id, false)}>
            Deny
          </button>
          <button type="submit" className={ALLOW_BUTTON_CLASS} autoFocus>
            <span className="truncate">Allow once</span>
          </button>
        </div>
      </form>
    </div>
  );
}
