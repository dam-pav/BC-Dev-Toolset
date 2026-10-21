table 50205 "BCD Receipt Run"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Principal; Guid) { DataClassification = EndUserPseudonymousIdentifiers; }
        field(3; Total; Integer) { }
        field(4; "Apply Count"; Integer) { }
        field(5; "Request Epoch"; Guid) { }
        field(6; "Retry Until"; DateTime) { }
    }
    keys
    {
        key(PK; "Run ID") { Clustered = true; }
    }
}
