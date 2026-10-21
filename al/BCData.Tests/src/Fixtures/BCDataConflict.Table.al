table 50206 "BCD Conflict Fixture"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Name; Code[20]) { }
        field(3; Principal; Guid) { DataClassification = EndUserPseudonymousIdentifiers; }
        field(4; Amount; Integer) { }
    }
    keys { key(PK; "Run ID", Name) { Clustered = true; } }
}

table 50207 "BCD Conflict Barrier"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; "Owner Session ID"; Integer) { }
    }
    keys { key(PK; "Run ID") { Clustered = true; } }
}
