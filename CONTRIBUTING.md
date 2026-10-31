# Contributing

Thank you for your interest in contributing to SMB Simulator Suite.

## Development setup

1. Create and activate a virtual environment.
2. Install dependencies and test tools:

   ```bash
   pip install -r requirements.txt pytest
   ```

3. Run tests:

   ```bash
   python -m pytest -q
   ```

4. Run case validation:

   ```bash
   python validation/validate_cases.py
   ```

5. Run the local web app:

   ```bash
   python run_suite.py
   ```

## Project style and boundaries

- Keep the simulation engine NumPy-only.
- Keep the web app dependency-free (Python standard library backend, vanilla JS frontend, no external libraries or CDNs).
- Keep component naming generic (for example: Wanted, Unwanted, Solvent, Wanted 1-3, Unwanted 1-3).
- Do not change validation targets unless the change is intentional and clearly explained.

## Branch and pull request workflow

1. Create a branch from `main` for each feature or fix.
2. Keep commits small and focused.
3. Ensure tests pass before opening a pull request.
4. Explain any validation impact in the pull request description.

## Adding a new isotherm

Follow the "Adding a thermodynamic model" section in README.md:

1. Implement a function `f(C, p)`.
2. Register it in `smbsim/isotherms.py` in `ISOTHERMS` with label, equation, and parameter names.
