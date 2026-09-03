export function submitFormWithFirstButton(form: HTMLFormElement): void {
  const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  form.requestSubmit(submitter ?? undefined);
}
