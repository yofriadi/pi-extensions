## MODIFIED Requirements

### Requirement: Operators are informed that Sessions needs content capture

Project documentation for the extension SHALL state that MLflow Chat Sessions conversation (bubbles / turn Inputs and Outputs) requires content capture, that content capture defaults to enabled, and that when it is explicitly disabled the Sessions turn body remains empty by design while structural tracing still works.
The README, `pi-mlflow.example.json` guidance, and the `/mlflow` status or command help surface SHALL collectively carry that information, as scoped by the scenarios below.

#### Scenario: README documents the requirement

- **WHEN** an operator reads the extension README for Chat Sessions or content capture
- **THEN** they are informed that content capture is required for session conversation bubbles and that it defaults to enabled

#### Scenario: Example config documents the requirement

- **WHEN** an operator reads `pi-mlflow.example.json` (or its adjacent documented keys)
- **THEN** they are informed that `captureContent` controls Sessions conversation text as well as child span bodies

#### Scenario: Status command surfaces content-capture implication for Sessions

- **WHEN** an operator runs the `/mlflow` status command
- **THEN** the status or help text indicates that content capture controls whether Sessions conversation text is recorded
