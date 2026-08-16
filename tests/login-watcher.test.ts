// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginWatcher } from '../src/preload/nav-layer';

const LOGIN_CONFIG = {
  formSelector: 'form',
  passwordSelector: 'input[type="password"]',
};

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('LoginWatcher', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports the PIN when the login form is submitted', () => {
    document.body.innerHTML = `
      <form action="/login" method="post">
        <input type="password" name="password" value="7654321" />
        <button type="submit">Log In</button>
      </form>`;
    const onPin = vi.fn();
    const watcher = new LoginWatcher(document, LOGIN_CONFIG, onPin);
    watcher.start();
    submit(document.querySelector('form')!);
    expect(onPin).toHaveBeenCalledWith('7654321');
    watcher.stop();
  });

  it('ignores forms without a password field or with an empty PIN', () => {
    document.body.innerHTML = `
      <form id="search"><input type="text" name="q" /></form>
      <form id="empty"><input type="password" name="password" value="" /></form>`;
    const onPin = vi.fn();
    const watcher = new LoginWatcher(document, LOGIN_CONFIG, onPin);
    watcher.start();
    submit(document.querySelector<HTMLFormElement>('#search')!);
    submit(document.querySelector<HTMLFormElement>('#empty')!);
    expect(onPin).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('respects the adapter form selector', () => {
    document.body.innerHTML = `
      <form id="other"><input type="password" value="1234" /></form>
      <form id="login-form"><input type="password" value="9999" /></form>`;
    const onPin = vi.fn();
    const watcher = new LoginWatcher(
      document,
      { formSelector: '#login-form', passwordSelector: 'input[type="password"]' },
      onPin,
    );
    watcher.start();
    submit(document.querySelector<HTMLFormElement>('#other')!);
    expect(onPin).not.toHaveBeenCalled();
    submit(document.querySelector<HTMLFormElement>('#login-form')!);
    expect(onPin).toHaveBeenCalledWith('9999');
    watcher.stop();
  });

  it('stops reporting after stop()', () => {
    document.body.innerHTML = `<form><input type="password" value="1" /></form>`;
    const onPin = vi.fn();
    const watcher = new LoginWatcher(document, LOGIN_CONFIG, onPin);
    watcher.start();
    watcher.stop();
    submit(document.querySelector('form')!);
    expect(onPin).not.toHaveBeenCalled();
  });
});
