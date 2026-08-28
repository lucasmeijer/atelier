# Syntax appearance fixture

Use this source in Read, Write, Bash heredocs, Markdown fences, Edit, and Review.

```ts
interface Person { name: string }
export function greet(person: Person): string { return `Hello ${person.name}`; } // greeting
const answer = 42;
```
```bash
name="Atelier"; rg -n 'TODO|FIXME' packages && printf '%s\n' "$name"
```
```python
def greet(name: str) -> str:
    return f"Hello {name}"  # greeting
```
```json
{"enabled": true, "count": 42, "items": ["one", "two"]}
```
```html
<main class="fixture"><strong>Hello</strong></main>
<style>.fixture { color: red; }</style>
```
```rust
pub fn answer() -> u32 { 42 }
```
