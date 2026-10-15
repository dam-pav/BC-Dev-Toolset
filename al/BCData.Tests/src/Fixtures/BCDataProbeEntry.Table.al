table 50201 "BCD Probe Entry"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; "Header Line No."; Integer) { }
        field(3; Bucket; Integer) { }
        field(4; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "Run ID", "Header Line No.", Bucket)
        {
            Clustered = true;
            SumIndexFields = Amount;
        }
    }
}
