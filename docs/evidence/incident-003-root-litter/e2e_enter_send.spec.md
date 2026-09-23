# E2E 测试规格：Enter 发送（Playwright 伪代码）

> 本工作区无浏览器环境，故 E2E 仅提供可执行的用例规格（未运行）。
> 选择器与 ACCEPTANCE_CRITERIA.md 第 1 节一致。

```js
// E2E-01 正常发送
test('E2E-01 enter sends message', async ({ page }) => {
  await page.goto('/chat');
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.type('hello');
  await input.press('Enter');
  await expect(page.getByTestId('message-list')).toContainText('hello');
  await expect(input).toHaveValue('');
});

// E2E-02 Shift+Enter 换行
test('E2E-02 shift+enter newline', async ({ page }) => {
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.type('line1');
  await input.press('Shift+Enter');
  await input.type('line2');
  await expect(input).toHaveValue('line1\nline2');
  await expect(page.getByTestId('message-list')).not.toContainText('line1');
});

// E2E-03 空输入不发送
test('E2E-03 empty enter no send', async ({ page }) => {
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.press('Enter');
  await expect(page.getByTestId('message-list').locator('li')).toHaveCount(0);
});

// E2E-04 纯空格不发送
test('E2E-04 whitespace enter no send', async ({ page }) => {
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.type('   ');
  await input.press('Enter');
  await expect(page.getByTestId('message-list').locator('li')).toHaveCount(0);
});

// E2E-05 禁用态不发送
test('E2E-05 disabled enter no send', async ({ page }) => {
  const input = page.getByTestId('chat-input');
  await input.evaluate(el => el.setAttribute('disabled', 'true'));
  await input.press('Enter');
  await expect(page.getByTestId('message-list').locator('li')).toHaveCount(0);
});

// E2E-06 输入法组合态不发送
test('E2E-06 composing enter no send', async ({ page }) => {
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart')));
  await input.type('ni');
  await input.press('Enter'); // 确认候选词，不应发送
  await expect(page.getByTestId('message-list').locator('li')).toHaveCount(0);
  await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend')));
  await input.press('Enter'); // 组合结束后才发送
  await expect(page.getByTestId('message-list').locator('li')).toHaveCount(1);
});
```
