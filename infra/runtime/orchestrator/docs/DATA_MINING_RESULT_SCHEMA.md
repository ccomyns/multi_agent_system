# Data-mining final result schema

Create `final_result.json` as a standardized database result whenever possible.
The admin UI supports exactly one or two tables and otherwise displays the valid
JSON as a fallback.

```json
{
  "kind": "data_mining_result",
  "schema_version": 1,
  "tables": [
    {
      "id": "pe_firms",
      "name": "PE Firms",
      "primary_key": "pe_firm_id",
      "columns": [
        {
          "key": "pe_firm_id",
          "label": "PE Firm ID",
          "type": "text",
          "nullable": false,
          "hidden": true
        },
        {
          "key": "name",
          "label": "Name",
          "type": "text",
          "nullable": false,
          "hidden": false
        },
        {
          "key": "website_url",
          "label": "Website",
          "type": "url",
          "nullable": true,
          "hidden": false
        }
      ],
      "rows": [
        {
          "pe_firm_id": "pe_firm_0001",
          "name": "Example Capital",
          "website_url": "https://example.com"
        }
      ]
    }
  ],
  "relationships": []
}
```

## Rules

- Emit exactly one table when the request describes one dataset and exactly two
  tables when it describes two interconnected datasets.
- Preserve the table order, visible column order, and human-readable names from
  the user's request. Do not add visible research columns the user did not ask
  for.
- Every table needs a lowercase snake-case `id`, `name`, `primary_key`, one or
  more `columns`, and a `rows` array. Every row must contain exactly every
  declared column.
- Column keys are lowercase snake case. Supported types are `text`, `number`,
  `boolean`, `date`, and `url`. Each column declares `nullable` and `hidden`.
- Use JSON `null` for unavailable nullable values, not an empty string or a
  placeholder such as `N/A`.
- Date values use `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. URL values are absolute
  HTTP(S) URLs.
- Primary-key values are non-null and unique. If the user did not request a
  natural identifier, create deterministic text identifiers such as
  `pe_firm_0001` and mark that column `hidden: true`.
- A one-table result has an empty `relationships` array.
- For two tables, create any needed foreign-key column, mark synthetic join keys
  hidden, and include at least one relationship:

```json
{
  "from_table": "portfolio_companies",
  "from_column": "pe_firm_id",
  "to_table": "pe_firms",
  "to_column": "pe_firm_id"
}
```

- The target relationship column is the target table's primary key. Every
  non-null foreign-key value must identify an existing target row, and the two
  key columns must have the same type.
- At least one column in each table must remain visible.
