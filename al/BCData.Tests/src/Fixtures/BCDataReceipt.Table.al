table 50204 "BCD Receipt Fixture"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Principal; Guid) { }
        field(3; "Request ID"; Guid) { }
        field(4; Payload; Text[100]) { }
        field(5; Completed; Boolean) { }
        field(6; Result; Text[2048]) { }
        field(7; "Owner Session ID"; Integer) { }
    }
    keys
    {
        key(PK; "Run ID", Principal, "Request ID") { Clustered = true; }
    }
}
