# Contributing to Codemap

Thank you for your interest in contributing to Codemap! We welcome contributions from qualitative researchers, developers, and designers.

---

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for all contributors. Please be respectful, constructive, and open to feedback.

---

## Development Setup

### Prerequisites

- **Node.js** (v20 or higher)
- **Rust** (stable toolchain via `rustup`)
- Platform-specific build tools for Tauri v2 (see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/))

### Getting Started

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/codemap.git
   cd codemap
   ```
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Run the development environment:
   ```bash
   npm run tauri dev
   ```

---

## Development Scripts

- `npm run tauri dev`: Starts the Tauri app with live frontend reloading and Rust compilation.
- `npm run dev`: Runs Vite in browser-only mode with simulated backend responses (great for rapid UI prototyping).
- `npm test`: Runs Vitest unit and contract tests across the frontend code.
- `cargo test --manifest-path src-tauri/Cargo.toml`: Runs Rust unit and integration tests.
- `npm run test:e2e`: Runs Playwright end-to-end user flow tests.
- `npm run build`: Bundles the React application for production.

---

## Coding Guidelines

- **TypeScript / React**:
  - Follow existing patterns and component structures.
  - Avoid unnecessary external dependencies.
  - Ensure type safety across all React components and utility functions.
- **Rust**:
  - Keep business logic deterministic and thoroughly tested.
  - Ensure all database queries through SQLite respect schema migrations and handle errors cleanly.
  - Run `cargo fmt` and `cargo clippy` before submitting changes.
- **Privacy First**:
  - Codemap's core architecture guarantees that transcript text and private memos remain strictly local on the user's disk. Ensure new features never inadvertently expose private data across network endpoints.

---

## Submitting Pull Requests

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Commit your changes with clear, concise commit messages.
3. Verify that all tests pass locally (`npm test` and `cargo test`).
4. Push your branch to your fork and open a Pull Request against `main`.
5. Provide a clear description of the problem solved, changes introduced, and testing steps in your PR description.

---

## License

By contributing to Codemap, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
