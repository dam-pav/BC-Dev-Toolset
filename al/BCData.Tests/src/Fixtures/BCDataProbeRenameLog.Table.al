table 50202 "BCD Probe Rename Log"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Event ID"; Guid) { }
        field(2; "Run ID"; Guid) { }
        field(3; "Old Line No."; Integer) { }
        field(4; "New Line No."; Integer) { }
    }

    keys
    {
        key(PK; "Event ID") { Clustered = true; }
    }
}
