table 50223 "BCD Coordinator Run"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Principal; Guid) { }
        field(3; "Other Request ID"; Guid) { }
        field(4; "Target ID"; Guid) { }
        field(5; Operation; Text[10]) { }
        field(6; "First Epoch"; Guid) { }
        field(7; "Other Epoch"; Guid) { }
    }
    keys { key(PK; "Run ID") { Clustered = true; } }
}
